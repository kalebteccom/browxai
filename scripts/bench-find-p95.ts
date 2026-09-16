// find() latency benchmark on REAL Chromium — the measurement RFC 0009 §"Honest
// limits" demands before and after `ElementSubstrate` lands.
//
// The risk the RFC names: `find` probes each candidate against the live DOM
// (hint disambiguation → bounding box → actionability), and moving those probes
// behind a port turns a chained `Locator` into a port call per probe. On a wide
// candidate list that is N extra awaits where there were none. Performance is a
// design input (architecture-principles.md §3), so the number gets measured, not
// asserted.
//
// The fixture is `/thin-a11y-page`: a table-and-bare-anchor layout whose CDP a11y
// tree carries almost no interactive nodes, so `find`'s candidates arrive from the
// DOM-walk fallback with the bare HTML tag in `role`. Those are the candidates
// whose role-locators do not resolve, which is exactly the case the probe
// timeout exists for and the worst case for per-candidate probing. A page whose
// candidates all resolve first-try would flatter the port.
//
// Run: pnpm tsx scripts/bench-find-p95.ts

import { chromium, type CDPSession, type Page } from "playwright-core";
import { find } from "../src/page/find.js";
import { CdpSnapshotSubstrate } from "../src/page/snapshot-substrate.js";
import { PlaywrightElementSubstrate } from "../src/page/element-substrate.js";
import { RefRegistry } from "../src/page/refs.js";
import { startFixture } from "../test/keystone/fixture.js";

const ITERATIONS = 120;
const WARMUP = 16;
/** Deliberately wide: the per-candidate probe cost is what is being measured, so
 *  a 1-candidate query would measure the compose step instead. */
const MAX_CANDIDATES = 20;
const QUERIES = ["story", "new", "past", "submit", "comments", "hacker news", "item", "show"];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function timeFind(
  page: Page,
  cdp: CDPSession,
): Promise<{ meanMs: number; p50: number; p95: number; p99: number; candidates: number }> {
  const samples: number[] = [];
  let candidates = 0;
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    // A fresh registry per iteration: a warm registry would let later runs skip
    // ref minting and drift the number downward over the sample.
    const refs = new RefRegistry();
    const substrate = new CdpSnapshotSubstrate(cdp);
    const elements = new PlaywrightElementSubstrate(() => page, "chromium");
    const query = QUERIES[i % QUERIES.length]!;
    const t0 = performance.now();
    const res = await find(elements, substrate, refs, {
      query,
      maxCandidates: MAX_CANDIDATES,
      testAttributes: ["data-testid"],
    });
    const dt = performance.now() - t0;
    if (i >= WARMUP) {
      samples.push(dt);
      candidates += res.candidates.length;
    }
  }
  samples.sort((a, b) => a - b);
  return {
    meanMs: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    p50: round(percentile(samples, 0.5)),
    p95: round(percentile(samples, 0.95)),
    p99: round(percentile(samples, 0.99)),
    candidates,
  };
}

async function main(): Promise<void> {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`${fixture.url}/thin-a11y-page`, { waitUntil: "domcontentloaded" });
    const r = await timeFind(page, cdp);
    console.log(
      JSON.stringify(
        {
          fixture: "/thin-a11y-page",
          iterations: ITERATIONS,
          warmup: WARMUP,
          maxCandidates: MAX_CANDIDATES,
          totalCandidatesProbed: r.candidates,
          meanMs: r.meanMs,
          p50: r.p50,
          p95: r.p95,
          p99: r.p99,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
}

await main();
