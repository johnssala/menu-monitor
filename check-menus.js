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
const BATCH_SIZE = 25;
const REQUEST_DELAY_MS = 20000; // 20 sec between pages
const PAGE_TIMEOUT_MS = 90000;

if (!fs.existsSync(SNAPSHOT_DIR)) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

    function addSection(title) {
      const section = { title, items: [], _seenItems: new Set() };
      sections.push(section);
      return section;
    }

    let currentSection = addSection("menu");

    function addItem(section, value) {
      if (!value) return;
      const v = value.trim();
      if (!v) return;
      if (section._seenItems.has(v)) return;

      section.items.push(v);
      section._seenItems.add(v);
    }

    // -----------------------------
    // FILTERS
    // -----------------------------

    function isNoise(text = "") {
      const t = text.toLowerCase();

      return (
        t.includes("privacy") ||
        t.includes("terms") ||
        t.includes("all rights reserved") ||
        t.includes("copyright") ||
        t.includes("cookie") ||
        t.includes("navigation") ||
        t.includes("footer") ||
        t.includes("accessibility")
      );
    }

    function isBadArea(el) {
      return (
        el.closest("nav") ||
        el.closest("footer") ||
        el.closest("aside") ||
        el.closest("[role='navigation']")
      );
    }

    function isPrice(text = "") {
      return /\$\s*\d/.test(text);
    }

    function hasMenuClass(el) {
      const cls = (el.className || "").toLowerCase();
      return (
        cls.includes("title") ||
        cls.includes("name") ||
        cls.includes("heading") ||
        cls.includes("menu-type")
      );
    }

    function isValid(el) {
      if (!el) return false;
      if (isBadArea(el)) return false;

      const text = el.innerText?.trim();
      if (!text) return false;

      if (isNoise(text)) return false;
      if (isPrice(text)) return false;

      return true;
    }

    // -----------------------------
    // CLASSIFICATION (IMPORTANT FIX)
    // -----------------------------

    function isTrueMenuSection(text) {
      const t = text.toLowerCase();

      // hard reject long garbage blocks
      if (t.length > 80) return false;

      // reject disclaimer/legal text
      if (
        t.includes("guests must") ||
        t.includes("allergy") ||
        t.includes("cross-contact") ||
        t.includes("foodborne") ||
        t.includes("consuming raw") ||
        t.includes("subject to change")
      ) return false;

      return (
        t === "menu" ||
        t.startsWith("menu for") ||
        t === "breakfast menu" ||
        t === "lunch menu" ||
        t === "dinner menu" ||
        t === "lunch and dinner menu"
      );
    }

    function isCategoryHeader(el, text) {
      const t = text.toLowerCase();

      // reject long junk
      if (t.length > 40) return false;

      // reject location / restaurant repeats
      if (
        t.includes("disney") ||
        t.includes("park") ||
        t.includes("restaurant") ||
        t.includes("street")
      ) return false;

      return (
        el.tagName.match(/^H[2-4]$/) &&
        !isTrueMenuSection(t)
      );
    }

    function isClearlyNotFood(text) {
      const t = text.toLowerCase();

      return (
        t.length > 120 || // huge paragraphs
        t.includes("guests must") ||
        t.includes("allergy") ||
        t.includes("dietary") ||
        t.includes("copyright") ||
        t.includes("privacy") ||
        t.includes("terms") ||
        t.includes("cookie") ||
        t.includes("accessibility")
      );
    }

    function isItem(el) {
      const text = el.innerText?.trim();
      if (!text) return false;

      if (isNoise(text)) return false;
      if (isPrice(text)) return false;
      if (isBadArea(el)) return false;

      const tag = el.tagName;

      // div/span must look like structured content
      if (tag === "DIV" || tag === "SPAN") {
        return hasMenuClass(el);
      }

      return true;
    }

    // -----------------------------
    // MAIN LOOP
    // -----------------------------

    const elements = root.querySelectorAll(
      "h1, h2, h3, h4, p, li, div, span"
    );

    elements.forEach(el => {
      if (!isValid(el)) return;

      const text = el.innerText.trim();

      // 1. REAL SECTION HEADERS
      if (isTrueMenuSection(text)) {
        currentSection = addSection(text);
        return;
      }

      // 2. CATEGORY HEADERS (NOT NEW SECTION)
      if (isCategoryHeader(el, text)) {
        addItem(currentSection, `— ${text}`);
        return;
      }

      // 3. ITEMS ONLY
      if (!isItem(el)) return;
      if (isClearlyNotFood(text)) return;

      addItem(currentSection, text);
    });

    return { sections };
  });
}

function normalizeMenu(raw) {
  const sections = (raw.sections || [])
    .map((section) => {
      const seen = new Set();

      const items = (section.items || [])
        .map(normalizeText)
        .filter(Boolean)
        .filter(item => {
          if (seen.has(item)) return false;
          seen.add(item);
          return true;
        });

      return {
        title: normalizeText(section.title || ""),
        items
      };
    })
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

    // Allow dynamic content to render
    await wait(5000);

    // Wait for likely menu text
    await page.waitForFunction(
      () => {
        const text = document.querySelector("main")?.innerText || document.body.innerText || "";
        return /seasonal offerings|entrées|plant-based|desserts|beverages|kids' meal/i.test(text);
      },
      { timeout: 20000 }
    ).catch(() => { });

    // --------------------
    // COMBOBOX (ONLY IF IT MAKES SENSE)
    // --------------------
    // --------------------
    const combo = await page.$('[role="combobox"]');

    if (combo) {
      try {
        await combo.evaluate(el => el.click());

        // wait for options to appear
        await page.waitForFunction(() => {
          return document.querySelectorAll(
            '[role="option"], li[role="option"], div[role="option"]'
          ).length > 0;
        }, { timeout: 8000 }).catch(() => { });

        await wait(500);

        const options = await page.$$(
          '[role="option"], li[role="option"], div[role="option"]'
        );

        if (options.length) {

          // normalize URL expectation
          const target = menu.url
            .toLowerCase()
            .replace(/\/$/, "")
            .split("/menus/")[1]
            ?.replace(/[-–—]/g, " ")
            ?.replace(/&/g, "and")
            ?.trim();

          let best = null;
          let bestScore = -1;

          for (const opt of options) {
            const text = await page.evaluate(el => el.innerText.toLowerCase(), opt);

            let score = 0;

            if (target && text.includes(target)) score += 10;

            // fallback fuzzy match
            if (target) {
              const words = target.split(/\s+/);
              for (const w of words) {
                if (w && text.includes(w)) score++;
              }
            }

            if (score > bestScore) {
              bestScore = score;
              best = opt;
            }
          }

          if (best) {
            await best.evaluate(el => el.scrollIntoView({ block: "center" }));

            await best.click();

            // Wait for ACTUAL content change
            const before = await page.evaluate(() =>
              document.body.innerText.slice(0, 500)
            );

            await page.waitForFunction(
              (prev) => {
                return document.body.innerText.slice(0, 500) !== prev;
              },
              { timeout: 10000 },
              before
            ).catch(() => { });

            await wait(1500);
          }
        }

      } catch (err) {
        console.log("Combobox failed:", err.message);
      }
    }

    // --------------------
    // ELSE: DO NOTHING
    // --------------------
    // snack menus, universal pages, single-menu pages
    // just scrape whatever is already rendered

    // Final wait for page content
    await wait(3000);

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
        await wait(REQUEST_DELAY_MS);
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
