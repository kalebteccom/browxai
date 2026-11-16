// Prove each fenced Chrome binary reaches loopback and nothing else, before browxai starts any browser.
// Usage: node fence-check.mjs <browsers-dir> <work-dir>
// Each binary opens a page from 127.0.0.1 that tries four images: three non-loopback URLs (must be blocked) and one
// loopback image (must load). Writes <work-dir>/fence.ok when every binary passes. Exit 0 pass, 2 fail (no browser may start).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startFixture } from "./fixture.mjs";

const [browsersArg, workArg] = process.argv.slice(2);
if (!browsersArg || !workArg) {
  console.error("usage: fence-check.mjs <browsers-dir> <work-dir>");
  process.exit(2);
}
const browsers = resolve(browsersArg);
const work = resolve(workArg);
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

const fixture = await startFixture({ fenceProbe: true });
let failed = 0;
try {
  for (const exe of exes) {
    const profile = mkdtempSync(join(work, "fence-profile-"));
    const res = spawnSync(
      exe,
      [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=10000",
        "--dump-dom",
        fixture.url,
      ],
      {
        encoding: "utf8",
        timeout: 90_000,
        killSignal: "SIGKILL",
        env: { PATH: process.env.PATH, HOME: work },
      },
    );
    const seen = /<p id="r">([^<]*)<\/p>/.exec(res.stdout ?? "")?.[1] ?? "(no result in the page)";
    const ok = seen === EXPECT;
    if (!ok) failed += 1;
    const why = ok
      ? ""
      : ` ${String(res.stderr ?? res.error?.message ?? "")
          .slice(0, 300)
          .replace(/\s+/g, " ")}`;
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
