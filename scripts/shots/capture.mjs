/* global window, document -- these run inside page.evaluate, in the browser. */
// Capture the home page and the getting-started page of the served docs site as images and print them to the step log.
// Usage: node capture.mjs <chrome-wrapper> <base-url> <out-dir>
// Chrome starts only through the fenced wrapper (scripts/design-audit/fence.sh), through playwright-core's executablePath.
// 2 pages x 2 viewports x 2 colour schemes = 8 images, full page, clipped to MAX_HEIGHT css pixels, WebP at QUALITY
// (sharp, from the website workspace). Without sharp the PNG from Playwright is kept and the log says so.
// Output on stdout: one SHOT-BEGIN/SHOT-END block per image, then SHOT-LIST lines, then SHOT-FACT lines (see log-block.mjs).
// Exit 0 when all 8 were captured, 1 when any capture failed, 2 on a usage error.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { shotBlock, shotList } from "./log-block.mjs";
import { measure } from "./measure.mjs";

const PAGES = [
  { slug: "home", path: "/" },
  { slug: "getting-started", path: "/getting-started/" },
];
const VIEWPORTS = [
  { width: 390, height: 844, scale: 2 },
  { width: 1280, height: 800, scale: 1 },
];
const SCHEMES = ["light", "dark"];
const QUALITY = 72;
const MAX_HEIGHT = 3000;
const SOFT_LIMIT = 60 * 1024;

const [wrapperArg, base, outArg] = process.argv.slice(2);
if (!wrapperArg || !base || !outArg) {
  console.error("usage: capture.mjs <chrome-wrapper> <base-url> <out-dir>");
  process.exit(2);
}
const wrapper = resolve(wrapperArg);
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

// sharp is a dev dependency of the website workspace, so it resolves from there and not from the repo root.
const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
let sharp = null;
try {
  sharp = createRequire(join(repoRoot, "website", "package.json"))("sharp");
} catch (err) {
  console.log(`no sharp (${String(err?.message ?? err).split("\n")[0]}): images stay PNG`);
}

/** Full-page PNG of the top MAX_HEIGHT css pixels. Falls back to a full capture cropped with sharp. */
async function shoot(page, width, height, scale) {
  const opts = { type: "png", animations: "disabled", timeout: 60_000 };
  try {
    const png = await page.screenshot({
      ...opts,
      fullPage: true,
      clip: { x: 0, y: 0, width, height },
    });
    return { png, via: "clip" };
  } catch (err) {
    if (!sharp) throw err;
    console.log(`clip capture failed (${String(err?.message ?? err).split("\n")[0]}), cropping`);
    const full = await page.screenshot({ ...opts, fullPage: true });
    const meta = await sharp(full).metadata();
    const crop = {
      left: 0,
      top: 0,
      width: Math.min(meta.width, Math.round(width * scale)),
      height: Math.min(meta.height, Math.round(height * scale)),
    };
    return { png: await sharp(full).extract(crop).png().toBuffer(), via: "crop" };
  }
}

/** Walk down the page once so lazy content is loaded, then back to the top. */
async function warm(page, height, step) {
  for (let y = 0; y < height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
}

async function capture(browser, pg, vp, scheme) {
  const name = `${pg.slug}-${vp.width}-${scheme}`;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.scale,
    colorScheme: scheme,
  });
  const failedRequests = [];
  try {
    const page = await context.newPage();
    page.on("requestfailed", (r) => failedRequests.push(r.url()));
    const response = await page.goto(base + pg.path, { waitUntil: "load", timeout: 30_000 });
    if (!response || response.status() !== 200) {
      throw new Error(`${pg.path} answered ${response ? response.status() : "nothing"}`);
    }
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const first = await page.evaluate(measure);
    await warm(page, Math.min(first.docH, MAX_HEIGHT), vp.height);
    const m = await page.evaluate(measure);
    const height = Math.min(m.docH, MAX_HEIGHT);
    const { png, via } = await shoot(page, vp.width, height, vp.scale);
    const webp = sharp ? await sharp(png).webp({ quality: QUALITY }).toBuffer() : null;
    const file = `${name}.${webp ? "webp" : "png"}`;
    const bytes = webp ?? png;
    writeFileSync(join(outDir, file), bytes);
    return { file, bytes, m, via, height, failedRequests, vp, scheme };
  } finally {
    await context.close().catch(() => {});
  }
}

function fact(r) {
  const { m, vp } = r;
  const h1 = m.h1.map((h) => `"${h.text}"${h.onScreen ? "" : " (hidden)"}`).join(" ") || "none";
  const parts = [
    `vp=${vp.width}x${vp.height}@${vp.scale}`,
    `scheme=${r.scheme} dark=${m.dark} theme=${m.theme || "unset"} bg=${m.bg.replace(/\s+/g, "")}`,
    `page=${m.vw}x${m.docH} shot=${r.height}${m.docH > MAX_HEIGHT ? " (clipped)" : ""} via=${r.via}`,
    `scrollW=${m.scrollW} vw=${m.vw} overflow-x=${m.scrollW > m.vw ? "YES" : "no"}`,
    `wider=${m.wider} uncontained=${m.uncontained}${m.samples.length ? ` [${m.samples.join(" ")}]` : ""}`,
    `words-first-screen=${m.words}`,
    `h1=${h1}`,
  ];
  if (m.lede) parts.push(`lede="${m.lede}"`);
  if (r.failedRequests.length) parts.push(`failed-requests=${r.failedRequests.length}`);
  if (r.bytes.length > SOFT_LIMIT) parts.push(`OVER-60KB=${r.bytes.length}`);
  return `SHOT-FACT ${r.file} ${parts.join(" ")}`;
}

const browser = await chromium.launch({ executablePath: wrapper, headless: true, timeout: 60_000 });
const results = [];
let failed = 0;
try {
  for (const pg of PAGES) {
    for (const vp of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const label = `${pg.slug} ${vp.width} ${scheme}`;
        try {
          const r = await capture(browser, pg, vp, scheme);
          results.push(r);
          console.log(`captured ${label}: ${r.file} ${r.bytes.length} bytes`);
        } catch (err) {
          failed += 1;
          console.log(`FAILED ${label}: ${String(err?.message ?? err).split("\n")[0]}`);
        }
      }
    }
  }
} finally {
  await browser.close().catch(() => {});
}

for (const r of results) console.log(shotBlock(r.file, r.bytes));
console.log(shotList(results.map((r) => ({ name: r.file, size: r.bytes.length }))));
for (const r of results) console.log(fact(r));
console.log(
  `SHOT-RESULT captured=${results.length} failed=${failed} encoder=${sharp ? `webp q${QUALITY}` : "png"}`,
);
process.exitCode = failed > 0 ? 1 : 0;
