// Prove the Chrome wrapper stays on loopback, and probe which colour schemes it can emulate.
// Usage: node fence-test.mjs <puppeteer-dir> <chrome-wrapper> <themes-file>
// Fails (exit 1) when a non-loopback request goes through or a loopback asset does not load.
// Writes the supported themes, one line ("light" or "light dark"), to <themes-file>; a missing dark scheme is a gap, not a failure.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [pptDir, chrome, themesFile] = process.argv.slice(2);
if (!pptDir || !chrome || !themesFile) {
  console.error("usage: fence-test.mjs <puppeteer-dir> <chrome-wrapper> <themes-file>");
  process.exit(2);
}
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
try {
  const light = await probe("--blink-settings=preferredColorScheme=0");
  if (!light.ok.has(`${base}ok.css`)) {
    console.error("FENCE FAIL: the loopback stylesheet did not load");
    failures += 1;
  }
  for (const url of OUTSIDE) {
    if (light.ok.has(url)) {
      console.error(`FENCE FAIL: reached ${url}`);
      failures += 1;
    } else if (light.failed.has(url)) {
      console.log(`fence ok: ${url} failed as required`);
    } else {
      console.error(`FENCE FAIL: ${url} neither failed nor finished, the test did not observe it`);
      failures += 1;
    }
  }
  const dark = await probe("--blink-settings=preferredColorScheme=1");
  const themes = [];
  if (light.scheme === "light") themes.push("light");
  if (dark.scheme === "dark" && light.scheme === "light") themes.push("dark");
  if (!themes.includes("light")) {
    console.error(`FENCE FAIL: light probe reported "${light.scheme}"`);
    failures += 1;
  }
  writeFileSync(themesFile, `${themes.join(" ")}\n`);
  console.log(
    themes.includes("dark")
      ? "themes: light and dark can be emulated"
      : `GAP: dark cannot be emulated (flag probe gave "${dark.scheme}"); the audit runs light only`,
  );
} finally {
  server.close();
}
process.exit(failures ? 1 : 0);
