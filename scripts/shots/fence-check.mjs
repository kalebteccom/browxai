/* global document, matchMedia -- these run inside page.evaluate, in the browser. */
// Prove the fenced Chrome wrapper reaches loopback and nothing else, and that colour scheme emulation works, before any page is captured.
// Usage: node fence-check.mjs <chrome-wrapper> <work-dir>
// The wrapper is launched the way capture.mjs launches it. A page on 127.0.0.1 tries three non-loopback images (must be blocked)
// and one loopback image (must load). A second context with colorScheme dark must match the dark media query.
// Writes <work-dir>/fence.ok on a pass. Exit 0 pass, 2 fail (run.sh then starts no browser).
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { startFixture } from "../first-run/fixture.mjs";

const [wrapperArg, workArg] = process.argv.slice(2);
if (!wrapperArg || !workArg) {
  console.error("usage: fence-check.mjs <chrome-wrapper> <work-dir>");
  process.exit(2);
}
const wrapper = resolve(wrapperArg);
const marker = join(resolve(workArg), "fence.ok");
rmSync(marker, { force: true });

const EXPECT = "blocked,blocked,blocked,reached";
const fixture = await startFixture({ fenceProbe: true });
let browser;
let ok = true;
try {
  browser = await chromium.launch({ executablePath: wrapper, headless: true, timeout: 60_000 });
  const page = await browser.newPage();
  await page.goto(fixture.url, { waitUntil: "load", timeout: 30_000 });
  await page.waitForFunction(() => document.getElementById("r")?.textContent !== "pending", null, {
    timeout: 30_000,
  });
  const seen = await page.evaluate(() => document.getElementById("r")?.textContent ?? "");
  console.log(`fence-check ${seen === EXPECT ? "ok" : "FAIL"}: ${seen} (want ${EXPECT})`);
  ok = seen === EXPECT;

  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ colorScheme: scheme });
    const p = await context.newPage();
    await p.goto(fixture.url, { waitUntil: "load", timeout: 30_000 });
    const dark = await p.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await context.close();
    const good = dark === (scheme === "dark");
    console.log(`fence-check ${good ? "ok" : "FAIL"}: colorScheme ${scheme} -> dark=${dark}`);
    ok = ok && good;
  }
} catch (err) {
  console.log(`fence-check FAIL: ${String(err?.message ?? err).split("\n")[0]}`);
  ok = false;
} finally {
  await browser?.close().catch(() => {});
  await fixture.close();
}
if (!ok) {
  console.error("fence-check: failed, so no page will be captured");
  process.exit(2);
}
writeFileSync(marker, "1\n");
