//  perf module keystone — drive the four new tools against real
// headless Chromium with fixture pages purpose-built to trip categories.
//
// Coverage:
//   - coverage_start → navigate → coverage_stop: dead-CSS file + dead-JS
//     function appear with usagePercent < 100.
//   - perf_audit: fixture page with dead CSS + long inline task + dead JS
//     produces summary.score < 100, topIssues populated, summary stays
//     under 2000-token budget.
//   - layout_thrash_trace: fixture page with rAF loop reading offsetHeight
//     in a write/read alternation produces forcedLayoutsCount > 0.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";
import { estimateTokens } from "../../src/util/tokens.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 180_000;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`perf-audit keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-perf-audit-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human";

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

interface JsCovEntry {
  url: string;
  totalBytes: number;
  usedBytes: number;
  usagePercent: number;
}
interface CssCovEntry {
  url: string;
  totalBytes: number;
  usedBytes: number;
  usagePercent: number;
}

describe("perf module keystone — coverage_start/stop", () => {
  it(
    "reports usagePercent < 100 on the dead-CSS + dead-JS fixture",
    async () => {
      const session = "ks-coverage";
      await callJson("open_session", { session, mode: "incognito" });
      const startR = await callJson<{ ok: boolean }>("coverage_start", { session });
      expect(startR.ok).toBe(true);
      // Navigate AFTER coverage starts so the dead-code load is captured.
      await callJson("navigate", { session, url: `${fixture.url}/perf-audit-page` });
      // The page is ready once its body renders; the inline long task blocks the
      // main thread, so this wait only resolves after it has run.
      const ready = await callJson<{ ok: boolean }>("wait_for", {
        session,
        text: "perf audit fixture",
        timeoutMs: 30_000,
      });
      expect(ready.ok).toBe(true);
      const stopR = await callJson<{
        ok: boolean;
        jsCoverage: JsCovEntry[];
        cssCoverage: CssCovEntry[];
      }>("coverage_stop", { session });
      expect(stopR.ok).toBe(true);
      // Dead-CSS file: 15 dead selectors + 1 used → expect <50% used.
      const deadCss = stopR.cssCoverage.find((c) => c.url.includes("perf-dead.css"));
      expect(deadCss).toBeDefined();
      expect(deadCss!.usagePercent).toBeLessThan(100);
      // Dead-JS file: only usedFn() is called → expect <100%.
      const deadJs = stopR.jsCoverage.find((j) => j.url.includes("perf-dead.js"));
      expect(deadJs).toBeDefined();
      expect(deadJs!.usagePercent).toBeLessThan(100);
      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("perf module keystone — perf_audit", () => {
  it(
    "produces summary.score < 100 + non-empty topIssues + stays under 2000-token summary budget",
    async () => {
      const session = "ks-audit";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/perf-audit-page` });
      // Short window — the page already finished its long task on load.
      const r = await callJson<{
        ok: boolean;
        summary: {
          score: number;
          topIssues: Array<{ category: string; severity: string; title: string }>;
        };
        byCategory: Record<string, { issues: unknown[]; remediations: unknown[] }>;
        evidence: { tracePath: string; coveragePath?: string };
        warnings: string[];
        tokensEstimate: number;
      }>("perf_audit", { session, durationMs: 2000, format: "summary" });
      expect(r.ok).toBe(true);
      expect(r.summary.score).toBeLessThan(100);
      expect(r.summary.topIssues.length).toBeGreaterThan(0);
      // tracePath should be workspace-rooted under <ws>/perf/.
      expect(r.evidence.tracePath).toContain(workspace);
      expect(r.evidence.tracePath).toContain("/perf/");
      // Summary-mode body must stay under 2000 tokens.
      const bodyTokens = estimateTokens(
        JSON.stringify({
          summary: r.summary,
          byCategory: r.byCategory,
          evidence: r.evidence,
          warnings: r.warnings,
        }),
      );
      expect(bodyTokens).toBeLessThanOrEqual(2000);
      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("perf module keystone — layout_thrash_trace", () => {
  it(
    "reports forcedLayoutsCount > 0 on the rAF-thrash fixture page",
    async () => {
      const session = "ks-thrash";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/layout-thrash-page` });
      // Page rAF loop runs 60 cycles; trace for 2s to capture some.
      const r = await callJson<{
        ok: boolean;
        forcedLayoutsCount: number;
        layoutShiftsCount: number;
        eventsByOrigin: Array<{ originatingStack: string; count: number; totalDurationMs: number }>;
        tracePath: string;
      }>("layout_thrash_trace", { session, durationMs: 2000 });
      expect(r.ok).toBe(true);
      // The rAF loop forces layout each frame; expect > 0. We tolerate the
      // exact number — chromium may coalesce events; we want a non-zero signal.
      expect(r.forcedLayoutsCount).toBeGreaterThan(0);
      expect(r.tracePath).toContain(workspace);
      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
