const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer");

const ROOT = __dirname;
const MENUS_FILE = path.join(ROOT, "menus.json");
const SNAPSHOT_DIR = path.join(ROOT, "snapshots");
const REPORT_FILE = path.join(ROOT, "changed-report.json");

// Tune these
// Batch size controls how many menus are checked per day
const BATCH_SIZE = 2;
const REQUEST_DELAY_MS = 20000; // 20 sec between pages
const PAGE_TIMEOUT_MS = 90000;

if (!fs.existsSync(SNAPSHOT_DIR)) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadMenus() {
  return JSON.parse(fs.readFileSync(MENUS_FILE, "utf8"));
}

function getDayBucket(totalMenus, batchSize) {
  const buckets = Math.ceil(totalMenus / batchSize);
  const epochDay = Math.floor(Date.now() / 86400000);
  return epochDay % buckets;
}

function pickBatch(allMenus, batchSize) {
  const bucket = getDayBucket(allMenus.length, batchSize);
  const start = bucket * batchSize;
  return allMenus.slice(start, start + batchSize);
}

function snapshotPath(id) {
  return path.join(SNAPSHOT_DIR, `${id}.json`);
}

function readSnapshot(id) {
  const file = snapshotPath(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeSnapshot(id, data) {
  fs.writeFileSync(snapshotPath(id), JSON.stringify(data, null, 2));
}

function stableHash(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function stripPrices(text) {
  return (text || "")
    .replace(/\$\s*\d+(?:\.\d{1,2})?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return stripPrices(text);
}

async function extractPageContent(page) {
  await page.waitForSelector("body", { timeout: 60000 });

  return await page.evaluate(() => {
    const root =
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;

    const rawLines = ((root ? root.innerText : document.body.innerText) || "")
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);

    const lines = rawLines.filter(line => {
      const l = line.toLowerCase();

      if (
        l.includes("show navigation") ||
        l.includes("show search") ||
        l === "tickets" ||
        l.includes("privacy policy") ||
        l.includes("terms of use") ||
        l.includes("legal notices") ||
        l.includes("all rights reserved") ||
        l.includes("site map") ||
        l.includes("show more links") ||
        l.includes("_satellite") ||
        l.includes("function ()") ||
        l.includes("callback:") ||
        l.includes("return document.queryselector") ||
        l.includes("trackclick") ||
        l.includes("annualpassholders") ||
        l.includes("parksandtickets")
      ) {
        return false;
      }

      if (
        line.startsWith("function") ||
        line.startsWith("return ") ||
        line.startsWith("callback:") ||
        line.startsWith("var ") ||
        line.startsWith("$el") ||
        line === "});" ||
        line === "}" ||
        line === "]," ||
        line === ");"
      ) {
        return false;
      }

      if (line.length > 200) {
        return false;
      }

      return true;
    });

    const startIndex = lines.findIndex(line => /menu/i.test(line));

    const finalLines = startIndex !== -1
      ? lines.slice(startIndex)
      : lines;

    const stopIndex = finalLines.findIndex(line =>
      /show more links|privacy policy|all rights reserved/i.test(line)
    );

    const cleanedLines = stopIndex !== -1
      ? finalLines.slice(0, stopIndex)
      : finalLines;

    return {
      sections: [
        {
          title: "page",
          items: cleanedLines
        }
      ]
    };
  });
}

function normalizeMenu(raw) {
  const sections = (raw.sections || [])
    .map((section) => ({
      title: normalizeText(section.title || ""),
      items: (section.items || []).map(normalizeText).filter(Boolean)
    }))
    .filter(section => section.title || section.items.length);

  return { sections };
}

function flattenMenu(menu) {
  const lines = [];
  for (const section of menu.sections) {
    if (section.title) lines.push(`## ${section.title}`);
    for (const item of section.items) lines.push(item);
  }
  return lines;
}

function diffMenus(oldMenu, newMenu) {
  const oldLines = new Set(flattenMenu(oldMenu));
  const newLines = new Set(flattenMenu(newMenu));

  const added = [...newLines].filter((x) => !oldLines.has(x));
  const removed = [...oldLines].filter((x) => !newLines.has(x));

  return { added, removed };
}

async function fetchMenu(browser, menu) {
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36"
    );

    await page.goto(menu.url, {
      waitUntil: "networkidle2",
      timeout: PAGE_TIMEOUT_MS
    });

    // Give dynamic page content time to render
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Wait for likely menu text to appear if it does
    await page.waitForFunction(
      () => {
        const text = (
          document.querySelector("main")?.innerText ||
          document.body.innerText ||
          ""
        );

        return /seasonal offerings|entrées|plant-based|desserts|beverages|kids' meal/i.test(text);
      },
      { timeout: 20000 }
    ).catch(() => {});

    const raw = await extractPageContent(page);
    return normalizeMenu(raw);
  } finally {
    await page.close();
  }
}

async function main() {
  const allMenus = loadMenus();
  const batch = pickBatch(allMenus, BATCH_SIZE);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const changes = [];

  try {
    for (let i = 0; i < batch.length; i++) {
      const menu = batch[i];
      console.log(`Checking ${menu.id} (${i + 1}/${batch.length})`);

      const newMenu = await fetchMenu(browser, menu);
      const oldMenu = readSnapshot(menu.id);

      if (!oldMenu) {
        writeSnapshot(menu.id, newMenu);
        console.log(`Initial snapshot saved for ${menu.id}`);
      } else {
        const oldHash = stableHash(oldMenu);
        const newHash = stableHash(newMenu);

        if (oldHash !== newHash) {
          const diff = diffMenus(oldMenu, newMenu);
          writeSnapshot(menu.id, newMenu);

          changes.push({
            id: menu.id,
            name: menu.name,
            park: menu.park,
            url: menu.url,
            added: diff.added,
            removed: diff.removed
          });

          console.log(`Changed: ${menu.id}`);
        } else {
          console.log(`No change: ${menu.id}`);
        }
      }

      if (i < batch.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(REPORT_FILE, JSON.stringify(changes, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});