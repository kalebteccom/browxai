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
//   - memory_diff: two synthetic heap snapshots on disk → retainerGrowth
//     surfaces the synthesised growers.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      // Give the page a tick to finish loading + executing the inline long task.
      await new Promise((res) => setTimeout(res, 1500));
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

describe("perf module keystone — memory_diff", () => {
  it(
    "diffs two synthetic heap snapshots and surfaces the synthesised growers",
    async () => {
      // Synthesise two tiny but spec-valid V8 heap snapshots directly on disk.
      // memory_diff is pure file-IO; no browser interaction needed for the
      // tool itself. We round-trip via the live MCP handler to exercise the
      // workspace-path + parsing wiring.
      const beforePath = join(workspace, "before.heapsnapshot");
      const afterPath = join(workspace, "after.heapsnapshot");
      writeFileSync(
        beforePath,
        makeFixtureSnapshot([
          { type: "object", name: "Cache", count: 1, size: 2_000 },
          { type: "object", name: "LeakyItem", count: 1, size: 1_000 },
        ]),
      );
      writeFileSync(
        afterPath,
        makeFixtureSnapshot([
          { type: "object", name: "Cache", count: 1, size: 10_000 },
          { type: "object", name: "LeakyItem", count: 1, size: 5_000 },
          { type: "object", name: "NewGrower", count: 1, size: 8_000 },
        ]),
      );
      const r = await callJson<{
        ok: boolean;
        retainerGrowth: Array<{ node: string; deltaBytes: number; deltaPercent: number | "+inf" }>;
        summary: { totalGrowth: number; top3Growers: Array<{ node: string }> };
      }>("memory_diff", { beforePath, afterPath });
      expect(r.ok).toBe(true);
      const names = r.retainerGrowth.map((g) => g.node);
      expect(names).toContain("object:Cache");
      expect(names).toContain("object:NewGrower");
      const cache = r.retainerGrowth.find((g) => g.node === "object:Cache")!;
      expect(cache.deltaBytes).toBe(8000);
      const newGrower = r.retainerGrowth.find((g) => g.node === "object:NewGrower")!;
      expect(newGrower.deltaPercent).toBe("+inf");
      expect(r.summary.totalGrowth).toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );

  it("rejects a workspace-escape path with a structured error", async () => {
    const r = await callJson<{ ok: boolean; error?: string }>("memory_diff", {
      beforePath: "../../etc/passwd",
      afterPath: "../../etc/passwd",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\$BROWX_WORKSPACE/);
  });
});

// Locally-redefined heap-snapshot fixture builder for the memory_diff keystone
// (mirrors the one in src/page/memory-diff.test.ts). Standalone so the test
// can stay self-contained.
function makeFixtureSnapshot(
  groups: Array<{ type: string; name: string; count: number; size: number }>,
): string {
  const nodeFields = [
    "type",
    "name",
    "id",
    "self_size",
    "edge_count",
    "trace_node_id",
    "detachedness",
  ];
  const edgeFields = ["type", "name_or_index", "to_node"];
  const nodeTypes = ["object", "closure", "hidden", "string"];
  const edgeTypes = ["context", "element"];
  const strings: string[] = [""];
  const stringIdx = (s: string): number => {
    const existing = strings.indexOf(s);
    if (existing >= 0) return existing;
    strings.push(s);
    return strings.length - 1;
  };
  const nodes: number[] = [];
  let id = 1;
  for (const g of groups) {
    const typeIdx = nodeTypes.indexOf(g.type);
    const nameIdx = stringIdx(g.name);
    for (let i = 0; i < g.count; i++) {
      nodes.push(typeIdx, nameIdx, id++, g.size, 0, 0, 0);
    }
  }
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: nodeFields,
        node_types: [nodeTypes, "string", "number", "number", "number", "number", "number"],
        edge_fields: edgeFields,
        edge_types: [edgeTypes, "string_or_number", "node"],
      },
      node_count: nodes.length / 7,
      edge_count: 0,
    },
    nodes,
    edges: [],
    strings,
  });
}
