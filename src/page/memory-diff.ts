// memory_diff — capability `read`. Pure-function consumer of two
// `.heapsnapshot` files. No browser interaction.
//
// "Take a snapshot → do thing → take another snapshot → who grew?" is the
// canonical leak-detection workflow. The two snapshots are the existing
// `heap_snapshot` tool output. This tool diffs them: groups nodes by
// `${type}:${name}`, sums self_size per group, reports per-group deltas
// (sizeBefore / sizeAfter / deltaBytes / deltaPercent / type).
//
// Noise filter: groups with `|deltaBytes| < 1024` are dropped — sub-KB
// noise is rampant in V8 heaps and crowds the actionable signal.
//
// Reuses the snapshot parser from `src/page/heap.ts`.

import { resolve, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parseHeapSnapshot } from "./heap.js";

/** One row in the retainer-growth report. */
export interface RetainerGrowthRow {
  /** Display name of the grouped nodes: `${type}:${name}` or just `name`. */
  node: string;
  /** V8 node-type (closure, object, hidden, …). */
  type: string;
  sizeBefore: number;
  sizeAfter: number;
  deltaBytes: number;
  /** Percent change. `sizeBefore:0` reports `deltaPercent: Infinity` →
   *  surfaced as the string `"+inf"` for JSON serialisability. */
  deltaPercent: number | "+inf";
}

export interface MemoryDiffSummary {
  totalGrowth: number;
  top3Growers: Array<{ node: string; deltaBytes: number; deltaPercent: number | "+inf" }>;
}

export interface MemoryDiffResult {
  retainerGrowth: RetainerGrowthRow[];
  summary: MemoryDiffSummary;
}

const NOISE_FILTER_BYTES = 1024;
const MAX_GROWTH_ROWS = 100;

/** Workspace-rooted path helper — same shape as `resolvePerfTracePath`. */
export function resolveHeapPath(workspaceRoot: string, p: string, tool: string): string {
  const resolved = resolve(workspaceRoot, p);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(`${tool}: paths must resolve inside $BROWX_WORKSPACE — got "${p}".`);
  }
  return resolved;
}

/** Pure aggregator — group nodes by `${type}:${name}` and sum self_size.
 *  Exported for unit tests against tiny in-memory snapshot JSON values. */
export function aggregateNodeSizes(
  parsed: ReturnType<typeof parseHeapSnapshot>,
): Map<string, { type: string; name: string; size: number }> {
  const out = new Map<string, { type: string; name: string; size: number }>();
  const total = parsed.nodes.length / parsed.nodeFieldCount;
  for (let i = 0; i < total; i++) {
    const base = i * parsed.nodeFieldCount;
    const typeIdx = parsed.nodes[base + parsed.fieldIdx.nodeType] ?? 0;
    const nameIdx = parsed.nodes[base + parsed.fieldIdx.nodeName] ?? 0;
    const selfSize = parsed.nodes[base + parsed.fieldIdx.nodeSelfSize] ?? 0;
    const type = parsed.nodeTypes[typeIdx] ?? "";
    const name = parsed.strings[nameIdx] ?? "";
    const display = type && name ? `${type}:${name}` : name || type || "<unknown>";
    const slot = out.get(display);
    if (slot) slot.size += selfSize;
    else out.set(display, { type, name, size: selfSize });
  }
  return out;
}

/** Pure diff helper — given two aggregator maps, return the growth report.
 *  Exported for unit tests. */
export function diffSizeMaps(
  before: Map<string, { type: string; name: string; size: number }>,
  after: Map<string, { type: string; name: string; size: number }>,
): MemoryDiffResult {
  const keys = new Set<string>();
  for (const k of before.keys()) keys.add(k);
  for (const k of after.keys()) keys.add(k);
  const rows: RetainerGrowthRow[] = [];
  let totalGrowth = 0;
  for (const k of keys) {
    const b = before.get(k);
    const a = after.get(k);
    const sizeBefore = b?.size ?? 0;
    const sizeAfter = a?.size ?? 0;
    const deltaBytes = sizeAfter - sizeBefore;
    if (Math.abs(deltaBytes) < NOISE_FILTER_BYTES) continue;
    const type = a?.type ?? b?.type ?? "";
    const deltaPercent: number | "+inf" =
      sizeBefore === 0 ? "+inf" : Math.round((deltaBytes / sizeBefore) * 10000) / 100;
    rows.push({
      node: k,
      type,
      sizeBefore,
      sizeAfter,
      deltaBytes,
      deltaPercent,
    });
    if (deltaBytes > 0) totalGrowth += deltaBytes;
  }
  rows.sort((a, b) => b.deltaBytes - a.deltaBytes);
  const top3 = rows.slice(0, 3).map((r) => ({
    node: r.node,
    deltaBytes: r.deltaBytes,
    deltaPercent: r.deltaPercent,
  }));
  return {
    retainerGrowth: rows.slice(0, MAX_GROWTH_ROWS),
    summary: { totalGrowth, top3Growers: top3 },
  };
}

/** Diff two heap snapshots at the given workspace-rooted paths. */
export function diffHeapSnapshots(
  workspaceRoot: string,
  beforePath: string,
  afterPath: string,
  tool = "memory_diff",
): MemoryDiffResult {
  const beforeResolved = resolveHeapPath(workspaceRoot, beforePath, tool);
  const afterResolved = resolveHeapPath(workspaceRoot, afterPath, tool);
  if (!existsSync(beforeResolved)) {
    throw new Error(`${tool}: beforePath not found at "${beforeResolved}"`);
  }
  if (!existsSync(afterResolved)) {
    throw new Error(`${tool}: afterPath not found at "${afterResolved}"`);
  }
  const beforeParsed = parseHeapSnapshot(readFileSync(beforeResolved, "utf8"));
  const afterParsed = parseHeapSnapshot(readFileSync(afterResolved, "utf8"));
  const beforeMap = aggregateNodeSizes(beforeParsed);
  const afterMap = aggregateNodeSizes(afterParsed);
  return diffSizeMaps(beforeMap, afterMap);
}
