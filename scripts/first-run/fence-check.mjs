/* global document -- these run inside page.evaluate, in the browser. */
// Prove each fenced Chrome binary reaches loopback and nothing else, before browxai starts any browser.
// Usage: node fence-check.mjs <browsers-dir> <work-dir> <project-dir>
// Each binary is launched the way browxai launches it: through playwright-core's chromium.launch({ executablePath }), taken from
// the project that npm installed. It opens a page from 127.0.0.1 that tries four images: three non-loopback URLs (must be
// blocked) and one loopback image (must load), and the page result is read with page.evaluate.
// Writes <work-dir>/fence.ok when every binary passes. Exit 0 pass, 2 fail (no browser may start).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { startFixture } from "./fixture.mjs";

const [browsersArg, workArg, projectArg] = process.argv.slice(2);
if (!browsersArg || !workArg || !projectArg) {
  console.error("usage: fence-check.mjs <browsers-dir> <work-dir> <project-dir>");
  process.exit(2);
}
const browsers = resolve(browsersArg);
const work = resolve(workArg);
const project = resolve(projectArg);

// playwright-core comes from the installed project: hoisted next to browxai, or nested under it.
const load = (from) => {
  try {
    return createRequire(from)("playwright-core");
  } catch {
    return null;
  }
};
const playwright =
  load(join(project, "package.json")) ??
  load(join(project, "node_modules", "browxai", "package.json"));
if (!playwright) {
  console.error(`fence-check: playwright-core does not resolve from ${project}`);
  process.exit(2);
}
const EXPECT = "blocked,blocked,blocked,reached";

const exes = execFileSync(
  "find",
  [
    browsers,
    "-maxdepth",
    "4",
    "-type",
    "f",
    "(",
    "-name",
    "chrome",
    "-o",
    "-name",
    "chrome-headless-shell",
    ")",
  ],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .sort();
if (exes.length === 0) {
  console.error(`fence-check: no chrome binary under ${browsers}`);
  process.exit(2);
}

// Chrome's own log lines, minus the dbus noise a container without a session bus prints on every start.
const clean = (text) =>
  String(text)
    .split("\n")
    .filter((l) => l.trim() && !/dbus|bus\.cc|connect to the bus/i.test(l))
    .join(" | ")
    .replace(/\s+/g, " ")
    .slice(0, 600);

const probe = async (exe) => {
  const log = [];
  let browser;
  try {
    browser = await playwright.chromium.launch({
      executablePath: exe,
      headless: true,
      timeout: 60_000,
      logger: {
        isEnabled: (name) => name === "browser",
        log: (_name, _severity, message) => log.push(String(message)),
      },
    });
    const page = await browser.newPage();
    await page.goto(fixture.url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForFunction(
      () => document.getElementById("r")?.textContent !== "pending",
      null,
      {
        timeout: 30_000,
      },
    );
    return {
      seen: await page.evaluate(() => document.getElementById("r")?.textContent ?? ""),
      log,
    };
  } catch (err) {
    return { seen: `(error: ${String(err?.message ?? err).split("\n")[0]})`, log, err };
  } finally {
    await browser?.close().catch(() => {});
  }
};

const fixture = await startFixture({ fenceProbe: true });
let failed = 0;
try {
  for (const exe of exes) {
    const { seen, log, err } = await probe(exe);
    const ok = seen === EXPECT;
    if (!ok) failed += 1;
    const why = ok
      ? ""
      : ` | log: ${clean(log.length > 0 ? log.join("\n") : (err?.message ?? "")) || "(nothing but dbus lines)"}`;
    console.log(
      `fence-check ${ok ? "ok" : "FAIL"}: ${exe.split("/").slice(-3).join("/")} -> ${seen}${why}`,
    );
  }
} finally {
  await fixture.close();
}
if (failed > 0) {
  console.error(`fence-check: ${failed} binary(ies) failed, so no browser will be started`);
  process.exit(2);
}
writeFileSync(join(work, "fence.ok"), `${exes.length}\n`);
