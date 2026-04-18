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

    const text = root.innerText || "";

    const hasMenuHeading = Array.from(
      root.querySelectorAll("h1, h2, h3, h4")
    ).some(el => /menu/i.test(el.innerText || ""));

    const hasMenuType = !!root.querySelector(".menu-type");

    let mode = "fallback";

    if (hasMenuHeading) mode = "heading";
    else if (hasMenuType) mode = "menu-type";

    const sections = [];

    function addSection(title) {
      const section = { title, items: [], _seenItems: new Set() };
      sections.push(section);
      return section;
    }

    let currentSection = null;

    const elements = root.querySelectorAll(
      "h1, h2, h3, h4, p, li, div, span"
    );

    // helper to safely accept text
    function addItem(section, value) {
      if (!value) return;
      if (section._seenItems.has(value)) return;

      section.items.push(value);
      section._seenItems.add(value);
    }

    // ----------------------------
    // MODE 1: HEADINGS CONTAIN MENU (PRIORITY 1)
    // ----------------------------
    if (mode === "heading") {
      elements.forEach(el => {
        // Only process div/span that are not legend/price
        if (el.tagName === "DIV" || el.tagName === "SPAN") {
          const classList = el.classList ? [...el.classList].map(c => c.toLowerCase()) : [];

          // Skip if it matches legend or price
          if (classList.some(c => c.includes("price"))) {
            return;
          }

          // Only process if class contains "title" or "name" dynamically
          if (!classList.some(c => c.includes("title") || c.includes("name"))) {
            return;
          }
        }

        const t = el.innerText?.trim();
        if (!t) return;

        if (el.tagName.match(/^H[1-4]$/) && /menu/i.test(t)) {
          currentSection = addSection(t);
          return;
        }

        if (!currentSection) {
          currentSection = addSection("menu");
        }

        addItem(currentSection, t);
      });

      return { sections };
    }

    // ----------------------------
    // MODE 2: .menu-type CONTAINERS (PRIORITY 2)
    // ----------------------------
    if (mode === "menu-type") {
      const containers = root.querySelectorAll(".menu-type");

      containers.forEach(container => {
        let section = addSection(
          container.innerText?.trim() || "menu"
        );

        container
          .querySelectorAll("h1, h2, h3, h4, p, li, div, span")
          .forEach(el => {
            // Only process div/span that are not legend/price
            if (el.tagName === "DIV" || el.tagName === "SPAN") {
              const classList = el.classList ? [...el.classList].map(c => c.toLowerCase()) : [];

              // Skip if it matches legend or price
              if (classList.some(c => c.includes("price"))) {
                return;
              }

              // Only process if class contains "title" or "name" dynamically
              if (!classList.some(c => c.includes("title") || c.includes("name"))) {
                return;
              }
            }
          });
      });

      return { sections };
    }

    // ----------------------------
    // MODE 3: FALLBACK FULL SCAN (PRIORITY 3)
    // ----------------------------
    currentSection = addSection("menu");

    elements.forEach(el => {
      // Only process div/span that are not legend/price
      if (el.tagName === "DIV" || el.tagName === "SPAN") {
        const classList = el.classList ? [...el.classList].map(c => c.toLowerCase()) : [];

        // Skip if it matches legend or price
        if (classList.some(c => c.includes("price"))) {
          return;
        }

        // Only process if class contains "title" or "name" dynamically
        if (!classList.some(c => c.includes("title") || c.includes("name"))) {
          return;
        }
      }
      
      const t = el.innerText?.trim();
      if (!t) return;

      addItem(currentSection, t);
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
    const combo = await page.$('button[role="combobox"]');

    if (combo) {
      try {
        await combo.click();

        await page.waitForSelector('li[role="option"]', {
          timeout: 5000
        }).catch(() => null);

        // small buffer for React/animation/render completion
        await page.waitForTimeout?.(300) || wait(300);

        const options = await page.$$('li[role="option"]');

        if (options.length === 0) {
          // Nothing to select, fall back to default render
          console.log("Combobox opened but no options found");
        } else {
          const slugWords = decodeURIComponent(menu.url.split("/menus/")[1] || "")
            .toLowerCase()
            .replace(/[-–—]/g, " ")
            .replace(/&/g, "and")
            .split(/\s+/)
            .filter(Boolean);

          const score = (text) => {
            if (!slugWords.length) return 0;

            let s = 0;
            for (const w of slugWords) {
              if (text.includes(w)) s++;
            }
            return s;
          };

          let bestOption = null;
          let bestScore = 0;

          for (const opt of options) {
            const text = await page.evaluate(
              el => (el.innerText || "").toLowerCase(),
              opt
            );

            const s = score(text);

            if (s > bestScore) {
              bestScore = s;
              bestOption = opt;
            }
          }

          if (bestOption) {
            await bestOption.click();

            await page.waitForFunction(() => {
              const list = document.querySelector('ul[role="listbox"]');
              return !list || list.hidden || list.classList.contains("hidden");
            }, { timeout: 5000 }).catch(() => { });
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
