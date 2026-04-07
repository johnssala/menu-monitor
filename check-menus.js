const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer");

const ROOT = __dirname;
const MENUS_DIR = path.join(ROOT, "menus");
const SNAPSHOT_DIR = path.join(ROOT, "snapshots");
const REPORT_FILE = path.join(ROOT, "changed-report.json");

// Tune these
// Batch size controls how many menus are checked per day
const BATCH_SIZE = 3;
const REQUEST_DELAY_MS = 20000; // 20 sec between pages
const PAGE_TIMEOUT_MS = 90000;

if (!fs.existsSync(SNAPSHOT_DIR)) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadMenus() {
  const files = fs
    .readdirSync(MENUS_DIR)
    .filter((file) => file.endsWith(".json"));

  let menus = [];

  for (const file of files) {
    const filePath = path.join(MENUS_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (!Array.isArray(data)) {
      throw new Error(`${file} must contain a JSON array`);
    }

    menus = menus.concat(data);
  }

  return menus;
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
  return await page.evaluate(() => {
    const root =
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;

    const sections = [];
    let currentSection = null;

    const elements = root.querySelectorAll("h1, h2, h3, h4, p, li");

    elements.forEach(el => {
      const text = el.innerText?.trim();
      if (!text) return;

      const l = text.toLowerCase();

      // skip junk
      if (
        l.includes("privacy policy") ||
        l.includes("terms of use") ||
        l.includes("legal notices") ||
        l.includes("all rights reserved") ||
        l.includes("show navigation") ||
        l.includes("show search") ||
        l.includes("show more links")
      ) return;

      // detect menu start
      if (el.tagName === "H2" && l.includes("menu")) {
        currentSection = { title: text, items: [] };
        sections.push(currentSection);
        return;
      }

      // detect section headers
      if (el.tagName === "H3") {
        currentSection = { title: text, items: [] };
        sections.push(currentSection);
        return;
      }

      if (!currentSection) return;

      currentSection.items.push(text);
    });

    return {
      sections: sections.length
        ? sections
        : [{ title: "page", items: [] }]
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
    ).catch(() => { });

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

      let newMenu;

      try {
        newMenu = await fetchMenu(browser, menu);
      } catch (err) {
        console.error(`Failed to fetch ${menu.id}:`, err.message);

        changes.push({
          id: menu.id,
          name: menu.name,
          park: menu.park,
          url: menu.url,
          error: err.message
        });

        continue;
      }
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