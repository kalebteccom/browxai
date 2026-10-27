// Prove the Chrome wrapper stays on loopback, and probe which colour schemes it can emulate.
// Usage: node fence-test.mjs <puppeteer-dir> <chrome-wrapper> <themes-file>
// Fails (exit 1) when a non-loopback request goes through or a loopback asset does not load.
// Writes the supported themes, one line ("light" or "light dark"), to <themes-file>; a missing dark scheme is a gap, not a failure.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length !== 3 || args.some((a) => !a)) {
  console.error("usage: fence-test.mjs <puppeteer-dir> <chrome-wrapper> <themes-file>");
  process.exit(2);
}
// createRequire and the browser launch need absolute paths.
const [pptDir, chrome, themesFile] = args.map((a) => resolve(a));
const puppeteer = createRequire(join(pptDir, "x.js"))("puppeteer-core");

const OUTSIDE = [
  "http://example.invalid/x.css",
  "https://1.1.1.1/probe.png",
  "http://203.0.113.9/probe.js",
];
const PAGE = `<!doctype html><meta charset="utf-8"><title>fence</title>
<link rel="stylesheet" href="/ok.css">
<link rel="stylesheet" href="${OUTSIDE[0]}">
<img src="${OUTSIDE[1]}" alt="">
<script src="${OUTSIDE[2]}"></script>
<p id="scheme"></p>
<script>document.getElementById("scheme").textContent = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";</script>`;

const server = createServer((req, res) => {
  if (req.url === "/ok.css") {
    res.writeHead(200, { "content-type": "text/css" }).end("p{color:#123}");
  } else {
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const probe = async (extraFlags) => {
  process.env.EXTRA_CHROME_FLAGS = extraFlags;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    const ok = new Set();
    const failed = new Set();
    page.on("requestfinished", (r) => ok.add(r.url()));
    page.on("requestfailed", (r) => failed.add(r.url()));
    await page.goto(base, { waitUntil: "networkidle0", timeout: 30000 });
    const scheme = await page.$eval("#scheme", (el) => el.textContent);
    return { ok, failed, scheme };
  } finally {
    await browser.close();
  }
};

let failures = 0;
const checkFence = (label, run) => {
  if (!run.ok.has(`${base}ok.css`)) {
    console.error(`FENCE FAIL (${label}): the loopback stylesheet did not load`);
    failures += 1;
  }
  for (const url of OUTSIDE) {
    if (run.ok.has(url)) {
      console.error(`FENCE FAIL (${label}): reached ${url}`);
      failures += 1;
    } else if (run.failed.has(url)) {
      console.log(`fence ok (${label}): ${url} failed as required`);
    } else {
      console.error(
        `FENCE FAIL (${label}): ${url} neither failed nor finished, so it was not observed`,
      );
      failures += 1;
    }
  }
};
try {
  // Blink's preferredColorScheme setting is an enum; the probe finds which value gives which scheme instead of assuming it.
  const flags = new Map(); // scheme -> chrome flag
  for (const value of [0, 1]) {
    const flag = `--blink-settings=preferredColorScheme=${value}`;
    const run = await probe(flag);
    checkFence(flag, run);
    console.log(`${flag} gives ${run.scheme}`);
    if (!flags.has(run.scheme)) flags.set(run.scheme, flag);
  }
  if (!flags.has("light")) {
    console.error("FENCE FAIL: no flag value gave the light scheme");
    failures += 1;
  }
  // One line per usable theme: "<theme> <chrome flag>".
  const lines = ["light", "dark"].filter((t) => flags.has(t)).map((t) => `${t} ${flags.get(t)}`);
  writeFileSync(themesFile, `${lines.join("\n")}\n`);
  console.log(
    flags.has("dark")
      ? "themes: light and dark can be emulated"
      : "GAP: dark cannot be emulated (neither flag value gave dark); the audit runs light only",
  );
} finally {
  server.close();
}
process.exit(failures ? 1 : 0);
