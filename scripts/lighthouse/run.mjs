// Run the pinned Lighthouse against the docs pages on loopback, RUNS times per page and preset (mobile = Lighthouse default, desktop = its desktop preset),
// and write every run (scores, failed audits, box load) to <results.json>. report.mjs turns that file into the log block and the exit status.
// Usage: node run.mjs <tools-dir> <chrome-wrapper> <base-url> <results.json> <page> [<page> ...]
// <tools-dir> holds node_modules/lighthouse and node_modules/chrome-launcher (fetch-tools.sh). <chrome-wrapper> is design-audit/fence.sh's wrapper, so Chrome can only reach loopback.
// Programmatic API on purpose: the CLI's error-reporting prompt and Sentry client are never loaded. Lighthouse itself sends nothing anywhere.
// CANONICAL URLS: every page is fetched once without following redirects before each run and must answer 200 (a redirect inflates TBT), and the
// URL Lighthouse ends on must equal the URL asked for.
import { execFileSync } from "node:child_process";
import { loadavg, cpus } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { failedAudits, scoresOf, CATEGORIES } from "./block.mjs";

const RUNS = 3;
const RUN_DEADLINE_MS = 150000;
const [toolsArg, wrapper, base, resultsFile, ...pages] = process.argv.slice(2);
if (!toolsArg || !wrapper || !base || !resultsFile || !pages.length) {
  console.error("usage: run.mjs <tools-dir> <chrome-wrapper> <base-url> <results.json> <page>...");
  process.exit(2);
}
const modules = join(resolve(toolsArg), "node_modules");
const load = (rel) => import(pathToFileURL(join(modules, rel)).href);
const { default: lighthouse, desktopConfig } = await load("lighthouse/core/index.js");
const { launch } = await load("chrome-launcher/dist/index.js");
const { version: lighthouseVersion } = JSON.parse(
  readFileSync(join(modules, "lighthouse/package.json"), "utf8"),
);

const boxNow = () => ({
  uptime: execFileSync("uptime", { encoding: "utf8" }).trim(),
  nproc: cpus().length,
});

/** The page must answer 200 on its own URL, with no redirect. */
async function assertCanonical(url) {
  const res = await fetch(url, { redirect: "manual" });
  await res.arrayBuffer();
  if (res.status !== 200)
    throw new Error(`${url} answered ${res.status} (needs 200 without a redirect)`);
}

async function once(url, preset) {
  await assertCanonical(url);
  const chrome = await launch({
    chromePath: wrapper,
    chromeFlags: ["--headless=new", "--disable-gpu"],
    logLevel: "silent",
  });
  const started = loadavg()[0];
  let timer;
  try {
    const flags = {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: CATEGORIES,
    };
    const run = lighthouse(url, flags, preset === "desktop" ? desktopConfig : undefined);
    run.catch(() => {}); // a run that loses the race to the deadline must not crash the process later
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no result after ${RUN_DEADLINE_MS / 1000}s`)),
        RUN_DEADLINE_MS,
      );
    });
    const result = await Promise.race([run, deadline]);
    const lhr = result?.lhr;
    if (!lhr) throw new Error("Lighthouse returned no result");
    if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
    if (lhr.finalDisplayedUrl !== url)
      throw new Error(`ended on ${lhr.finalDisplayedUrl}, asked for ${url}`);
    return {
      scores: scoresOf(lhr),
      failures: failedAudits(lhr),
      load: started,
      benchmark: lhr.environment?.benchmarkIndex,
      chrome: lhr.environment?.hostUserAgent?.match(/Chrome\/[\d.]+/)?.[0] ?? "Chrome",
    };
  } finally {
    clearTimeout(timer);
    await chrome.kill();
  }
}

const out = { lighthouseVersion, runsPerPage: RUNS, start: boxNow(), pages: [] };
for (const page of pages) {
  for (const preset of ["mobile", "desktop"]) {
    const url = `${base}${page}`;
    const runs = [];
    for (let i = 1; i <= RUNS; i += 1) {
      try {
        runs.push(await once(url, preset));
      } catch (error) {
        runs.push({
          error: `${error?.message ?? error} @ ${String(error?.stack ?? "")
            .split("\n")
            .slice(1, 5)
            .map((l) => l.trim().replace(/^at /, ""))
            .join(" < ")}`,
          load: loadavg()[0],
        });
      }
      const r = runs.at(-1);
      console.log(
        `lighthouse ${preset} ${page} run ${i}/${RUNS}: ${r.error ? `ERROR ${r.error}` : JSON.stringify(r.scores)}`,
      );
    }
    out.pages.push({ page, preset, runs });
  }
}
out.end = boxNow();
out.chrome = out.pages.flatMap((p) => p.runs).find((r) => r.chrome)?.chrome ?? "Chrome";
out.benchmarks = out.pages.flatMap((p) =>
  p.runs.map((r) => r.benchmark).filter((b) => b !== undefined),
);
writeFileSync(resultsFile, JSON.stringify(out));
