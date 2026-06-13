// Envelope-perf benchmark (RFC 0002 D5 / open input #4 — the explicit P2b
// "measure the hot path" requirement). It times the per-action ActionResult
// network tap two ways on REAL Chromium:
//
//   (A) CDP NetworkTap            — the chromium path (kept on chromium)
//   (B) Playwright context-event  — the firefox/webkit path
//
// against the same fixture page that fires real subresource requests, so the
// numbers reflect the actual per-action open()+settle+close() cost the envelope
// pays. The verdict gates the decision: if the event path adds measurable
// per-action cost on chromium, keep chromium on the CDP substrate (the hybrid
// already does — `networkSubstrateFor` routes chromium → CdpNetworkSubstrate).
//
// Run: pnpm tsx scripts/bench-network-envelope.ts

import { chromium, type BrowserContext, type Page } from "playwright-core";
import { NetworkTap, PlaywrightNetworkTap } from "../src/page/network.js";
import { startFixture } from "../test/keystone/fixture.js";

const ITERATIONS = 60;
const WARMUP = 8;
const SETTLE_MS = 100; // shrunk vs the real 400ms window — we measure tap overhead, not settle

interface ActionTap {
  open(): Promise<void>;
  close(): Promise<{ summary: { total: number } }>;
}

async function timeTap(
  label: string,
  page: Page,
  url: string,
  makeTap: () => ActionTap,
): Promise<{ label: string; meanMs: number; p50: number; p95: number; totalSeen: number }> {
  const samples: number[] = [];
  let totalSeen = 0;
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    const tap = makeTap();
    const t0 = performance.now();
    await tap.open();
    // The "action": a reload that fires the page's subresource requests so the
    // tap sees real Network traffic (the same shape the envelope captures).
    await page.goto(`${url}/perf-audit-page`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const res = await tap.close();
    const dt = performance.now() - t0;
    if (i >= WARMUP) {
      samples.push(dt);
      totalSeen += res.summary.total;
    }
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    label,
    meanMs: round(mean),
    p50: round(samples[Math.floor(samples.length * 0.5)]!),
    p95: round(samples[Math.floor(samples.length * 0.95)]!),
    totalSeen: Math.round(totalSeen / ITERATIONS),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  // Warm the page once so the first navigation's compile cost doesn't skew run A.
  await page.goto(`${fixture.url}/perf-audit-page`, { waitUntil: "domcontentloaded" });

  const cdpRun = await timeTap(
    "CDP NetworkTap (chromium path)",
    page,
    fixture.url,
    () => new NetworkTap(cdp, null),
  );
  const pwRun = await timeTap(
    "Playwright-event tap (firefox/webkit path)",
    page,
    fixture.url,
    () => new PlaywrightNetworkTap(context, null),
  );

  console.log("\n=== Envelope network-tap benchmark (real Chromium) ===");
  console.log(
    `iterations=${ITERATIONS} (warmup=${WARMUP}), settle=${SETTLE_MS}ms, action=goto(perf-audit-page)\n`,
  );
  for (const r of [cdpRun, pwRun]) {
    console.log(
      `${r.label.padEnd(44)}  mean=${String(r.meanMs).padStart(7)}ms  p50=${String(r.p50).padStart(7)}ms  p95=${String(r.p95).padStart(7)}ms  reqsSeen≈${r.totalSeen}`,
    );
  }
  const deltaMean = round(pwRun.meanMs - cdpRun.meanMs);
  const deltaPct = round((deltaMean / cdpRun.meanMs) * 100);
  console.log(
    `\nΔ mean (event − CDP) = ${deltaMean}ms (${deltaPct}%). Both dominated by goto+settle (~${SETTLE_MS}ms);` +
      ` the tap open/close overhead is the sub-ms residual.\n`,
  );

  // Isolate the pure tap open()+close() overhead with NO navigation — this is the
  // per-action allocation/listener cost the envelope pays on top of the action
  // itself. The number that proves "no added allocation per action on chromium".
  const N = 500;
  let cdpOverhead = 0;
  for (let i = 0; i < N; i++) {
    const tap = new NetworkTap(cdp, null);
    const t = performance.now();
    await tap.open();
    await tap.close();
    cdpOverhead += performance.now() - t;
  }
  let pwOverhead = 0;
  for (let i = 0; i < N; i++) {
    const tap = new PlaywrightNetworkTap(context, null);
    const t = performance.now();
    await tap.open();
    await tap.close();
    pwOverhead += performance.now() - t;
  }
  console.log(
    `pure tap open()+close() overhead (no nav, ${N} iters):\n` +
      `  CDP NetworkTap          ${round(cdpOverhead / N)}ms/action\n` +
      `  Playwright-event tap    ${round(pwOverhead / N)}ms/action\n`,
  );

  await browser.close();
  await fixture.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
