// V8 heap snapshots — capability `action` (writes a file).
//
// "This page slowly leaks memory — what's holding the old DOM tree alive?"
// has no diagnostic surface in browxai's read-only tools: a screenshot /
// snapshot / network slice shows what's on the page now, not what's still
// retained from a previous state. CDP `HeapProfiler.takeHeapSnapshot`
// produces a V8 heap snapshot blob — the same `.heapsnapshot` format
// chrome://inspect's Memory tab consumes — that lets the agent ask
// "who points to objects named X / typed Y" against the live VM.
//
// Two tools, one lifecycle (no start/stop — a snapshot is a single
// point-in-time capture, not a recording window):
//   - heap_snapshot({path?})         → write a snapshot file under
//                                       `<workspace>/heap-snapshots/<id>-<ts>.heapsnapshot`.
//                                       Default path is in the workspace,
//                                       explicit `path` is enforced inside
//                                       the workspace.
//   - heap_retainers({snapshotPath,  → parse a written snapshot and return
//                     query, …})       top retainers of nodes matching the
//                                       query (against node name OR class
//                                       constructor name). Pure file read +
//                                       in-process parse — no CDP touch.
//
// CDP delivers the snapshot as a stream of `HeapProfiler.addHeapSnapshotChunk`
// events fired during `HeapProfiler.takeHeapSnapshot`. The chunks are JSON
// fragments that, concatenated in order, form the complete `.heapsnapshot`
// JSON document. We buffer them and write at end — same pattern as
// `src/page/perf.ts`'s `Tracing.dataCollected` → `tracingComplete` flow,
// but without a long-running state-machine (a snapshot is one-shot).

import type { CDPSession } from "playwright-core";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

/** Take a V8 heap snapshot on `cdp`. Returns the full snapshot JSON as a
 *  string (the format chrome://inspect's Memory tool consumes). Buffers
 *  `HeapProfiler.addHeapSnapshotChunk` events fired during
 *  `HeapProfiler.takeHeapSnapshot`. Detaches its listeners on return —
 *  no leak across calls. */
export async function takeHeapSnapshot(cdp: CDPSession): Promise<string> {
  const chunks: string[] = [];
  const onChunk = (e: { chunk: string }) => {
    if (typeof e?.chunk === "string") chunks.push(e.chunk);
  };
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    // `reportProgress:false` — we don't need the progress events, just the
    // chunks. `captureNumericValue` is omitted; the default snapshot covers
    // what a retainer query needs (we don't read primitive values).
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Workspace path helper — mirrors `resolvePerfTracePath` in src/page/perf.ts.

export function resolveHeapSnapshotPath(workspaceRoot: string, p: string, tool: string): string {
  const resolved = resolve(workspaceRoot, p);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(`${tool}: \`path\` must resolve inside $BROWX_WORKSPACE — got "${p}".`);
  }
  return resolved;
}

/** Default snapshot filename under
 *  `<workspace>/heap-snapshots/<sessionId>-<ts>.heapsnapshot`. The
 *  `.heapsnapshot` extension is the one DevTools' Memory panel and
 *  `chrome://inspect` recognise on drag-and-drop. */
export function defaultHeapSnapshotPath(workspaceRoot: string, sessionId: string): string {
  const safe = (sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(workspaceRoot, "heap-snapshots", `${safe}-${ts}.heapsnapshot`);
}

/** Write a snapshot JSON string to a workspace-rooted file. Creates the
 *  parent dir if missing. Returns the resolved path + byte count. */
export function writeHeapSnapshotFile(
  workspaceRoot: string,
  filePath: string,
  snapshotJson: string,
  tool: string,
): { resolved: string; bytes: number } {
  // Path is workspace-rooted by construction via `resolveHeapSnapshotPath`.
  const resolved = resolveHeapSnapshotPath(workspaceRoot, filePath, tool);
  const parent = dirname(resolved);
  // ws.sub-style: ensure parent exists under workspace.root.
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  // ws.root-rooted path — see resolveHeapSnapshotPath above for the guard.
  writeFileSync(resolved, snapshotJson, "utf8");
  return { resolved, bytes: Buffer.byteLength(snapshotJson, "utf8") };
}

// ---------------------------------------------------------------------------
// .heapsnapshot parsing + retainer query.
//
// The V8 heap snapshot format is a single JSON document of the shape:
//   {
//     "snapshot": {
//       "meta": {
//         "node_fields": ["type","name","id","self_size","edge_count","trace_node_id","detachedness"],
//         "node_types":  [ [ ...type names ... ], "string", "number", ... ],
//         "edge_fields": ["type","name_or_index","to_node"],
//         "edge_types":  [ [ ...type names ... ], "string_or_number", "node" ]
//       },
//       "node_count": N,
//       "edge_count": M
//     },
//     "nodes":   [flat int array, node_fields.length ints per node, in order],
//     "edges":   [flat int array, edge_fields.length ints per edge],
//     "strings": ["...","..."]
//   }
//
// Nodes own a sequential slice of `edges` of length `edge_count` (the
// per-node field). Edges' `to_node` is a BYTE offset into the `nodes`
// array (V8 quirk: it's NOT a node index — it's the index of the FIRST
// field of that node in the flat `nodes` array). We treat it as a
// `nodes`-array index and divide by node_field_count to get the logical
// node index.
//
// Top retainers: for each node matching the query (by name/constructor),
// find every node that has an edge pointing TO it; aggregate by retainer,
// sort by retainer self_size desc, cap at MAX_RETAINER_RESULTS.

/** Parsed snapshot summary surfaced on `heap_retainers` results. */
export interface HeapSnapshotSummary {
  nodeCount: number;
  edgeCount: number;
  stringCount: number;
  /** Sum of `self_size` across every node — total heap occupied. */
  totalSelfSize: number;
}

/** One retainer row in a `heap_retainers` result. */
export interface HeapRetainerRow {
  /** Display name of the retainer node: `${type}:${name}` or just `name`. */
  retainerName: string;
  retainerType: string;
  retainerSelfSize: number;
  /** How many distinct edges from this retainer point to a matching node. */
  edgesToMatches: number;
  /** Display names of up to 5 matching nodes this retainer holds. */
  sampleHeldNodes: string[];
}

/** Result body of a `heap_retainers` call. */
export interface HeapRetainersResult {
  summary: HeapSnapshotSummary;
  /** How many nodes the query matched. */
  matchCount: number;
  /** Cap-applied retainer rows, sorted by retainer self_size desc. */
  retainers: HeapRetainerRow[];
  /** Sample of matched node display names (first 10). Lets the caller
   *  sanity-check the query without parsing the full retainer set. */
  sampleMatches: string[];
  /** Non-fatal extraction warnings (unknown field layout, etc.). */
  warnings?: string[];
}

const MAX_RETAINER_RESULTS = 50;
const MAX_SAMPLE_HELD = 5;
const MAX_SAMPLE_MATCHES = 10;

/** Internal parsed snapshot. */
interface ParsedSnapshot {
  nodeFields: string[];
  nodeTypes: string[];
  edgeFields: string[];
  edgeTypes: string[];
  nodes: number[];
  edges: number[];
  strings: string[];
  nodeFieldCount: number;
  edgeFieldCount: number;
  /** Index into nodeFields for fast access. */
  fieldIdx: {
    nodeType: number;
    nodeName: number;
    nodeSelfSize: number;
    nodeEdgeCount: number;
    edgeType: number;
    edgeName: number;
    edgeToNode: number;
  };
}

/** Parse a `.heapsnapshot` JSON string into the structural form retainer
 *  queries walk. Throws on malformed input — the caller surfaces a
 *  structured error. */
export function parseHeapSnapshot(snapshotJson: string): ParsedSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(snapshotJson);
  } catch (err) {
    throw new Error(
      `heap snapshot is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("heap snapshot: top-level value is not an object");
  }
  const r = raw as Record<string, unknown>;
  const snapshot = r.snapshot as Record<string, unknown> | undefined;
  const meta = snapshot?.meta as Record<string, unknown> | undefined;
  if (!meta || !Array.isArray(meta.node_fields) || !Array.isArray(meta.edge_fields)) {
    throw new Error("heap snapshot: missing snapshot.meta.node_fields / edge_fields");
  }
  const nodeFields = (meta.node_fields as unknown[]).map(String);
  const edgeFields = (meta.edge_fields as unknown[]).map(String);
  // node_types[0] / edge_types[0] is the array of distinct type names
  // (the others are scalar tags like "string" or "number"). V8 quirks.
  const nodeTypesRaw = Array.isArray(meta.node_types) ? (meta.node_types as unknown[]) : [];
  const edgeTypesRaw = Array.isArray(meta.edge_types) ? (meta.edge_types as unknown[]) : [];
  const nodeTypes = Array.isArray(nodeTypesRaw[0])
    ? (nodeTypesRaw[0] as unknown[]).map(String)
    : [];
  const edgeTypes = Array.isArray(edgeTypesRaw[0])
    ? (edgeTypesRaw[0] as unknown[]).map(String)
    : [];

  const nodes = Array.isArray(r.nodes) ? (r.nodes as number[]) : null;
  const edges = Array.isArray(r.edges) ? (r.edges as number[]) : null;
  const strings = Array.isArray(r.strings) ? (r.strings as unknown[]).map(String) : null;
  if (!nodes || !edges || !strings) {
    throw new Error("heap snapshot: missing nodes / edges / strings arrays");
  }

  const fieldIdx = {
    nodeType: nodeFields.indexOf("type"),
    nodeName: nodeFields.indexOf("name"),
    nodeSelfSize: nodeFields.indexOf("self_size"),
    nodeEdgeCount: nodeFields.indexOf("edge_count"),
    edgeType: edgeFields.indexOf("type"),
    edgeName: edgeFields.indexOf("name_or_index"),
    edgeToNode: edgeFields.indexOf("to_node"),
  };
  // Required fields for retainer walking — bail if any are missing.
  for (const [k, v] of Object.entries(fieldIdx)) {
    if (v < 0) {
      throw new Error(`heap snapshot: required field "${k}" missing from meta`);
    }
  }
  return {
    nodeFields,
    nodeTypes,
    edgeFields,
    edgeTypes,
    nodes,
    edges,
    strings,
    nodeFieldCount: nodeFields.length,
    edgeFieldCount: edgeFields.length,
    fieldIdx,
  };
}

/** Read a snapshot file from disk + parse. */
export function readHeapSnapshotFile(
  workspaceRoot: string,
  filePath: string,
  tool: string,
): { parsed: ParsedSnapshot; resolved: string } {
  const resolved = resolveHeapSnapshotPath(workspaceRoot, filePath, tool);
  if (!existsSync(resolved)) {
    throw new Error(`${tool}: snapshot file not found at "${resolved}" — call heap_snapshot first`);
  }
  const raw = readFileSync(resolved, "utf8");
  const parsed = parseHeapSnapshot(raw);
  return { parsed, resolved };
}

/** Display name for a node — `${type}:${name}` if both useful, else
 *  whichever is non-empty. Falls back to `node#${index}`. */
function nodeDisplayName(p: ParsedSnapshot, nodeIdx: number): string {
  const base = nodeIdx * p.nodeFieldCount;
  const typeIdx = p.nodes[base + p.fieldIdx.nodeType] ?? 0;
  const nameIdx = p.nodes[base + p.fieldIdx.nodeName] ?? 0;
  const type = p.nodeTypes[typeIdx] ?? "";
  const name = p.strings[nameIdx] ?? "";
  if (type && name) return `${type}:${name}`;
  if (name) return name;
  if (type) return type;
  return `node#${nodeIdx}`;
}

/** Self size of a node. */
function nodeSelfSize(p: ParsedSnapshot, nodeIdx: number): number {
  return p.nodes[nodeIdx * p.nodeFieldCount + p.fieldIdx.nodeSelfSize] ?? 0;
}

/** Query input for `heap_retainers`. Either `name` (string match against
 *  node display name) or `type` (string match against node type). Both
 *  may be set — the row matches when both match. */
export interface HeapRetainersQuery {
  /** Substring or exact string to match against the node's display name
   *  (the V8 string-table entry). Case-sensitive. */
  name?: string;
  /** Exact node-type to match (`"closure"`, `"object"`, `"hidden"`, …).
   *  See V8's `node_types[0]` for the catalogue in the snapshot. */
  type?: string;
  /** When `name` is set: match style. `"exact"` (default) requires
   *  string equality; `"substring"` allows substring containment. */
  nameMatch?: "exact" | "substring";
}

/** Run a retainer query over a parsed snapshot. Pure — exported for unit
 *  tests; the public-facing tool composes parse → query. */
export function queryRetainers(p: ParsedSnapshot, q: HeapRetainersQuery): HeapRetainersResult {
  const warnings: string[] = [];
  if (!q.name && !q.type) {
    // Caller must specify SOMETHING — running against every node would
    // dump millions of edges and is never the right answer.
    throw new Error("heap_retainers: query must specify at least one of `name` or `type`");
  }
  const nameMatch = q.nameMatch ?? "exact";
  const nodeCount = (p.nodes.length / p.nodeFieldCount) | 0;
  const edgeCount = (p.edges.length / p.edgeFieldCount) | 0;

  // First pass: identify matching nodes + accumulate self-size totals.
  const matchSet = new Set<number>();
  let totalSelfSize = 0;
  for (let i = 0; i < nodeCount; i++) {
    const base = i * p.nodeFieldCount;
    const typeIdx = p.nodes[base + p.fieldIdx.nodeType] ?? 0;
    const nameIdx = p.nodes[base + p.fieldIdx.nodeName] ?? 0;
    const selfSize = p.nodes[base + p.fieldIdx.nodeSelfSize] ?? 0;
    totalSelfSize += selfSize;
    const type = p.nodeTypes[typeIdx] ?? "";
    const name = p.strings[nameIdx] ?? "";
    // type filter first (cheap)
    if (q.type && type !== q.type) continue;
    if (q.name) {
      if (nameMatch === "exact" ? name !== q.name : !name.includes(q.name)) continue;
    }
    matchSet.add(i);
  }

  const summary: HeapSnapshotSummary = {
    nodeCount,
    edgeCount,
    stringCount: p.strings.length,
    totalSelfSize,
  };

  if (matchSet.size === 0) {
    return { summary, matchCount: 0, retainers: [], sampleMatches: [] };
  }

  // Sample matches for the caller's sanity check (cap at 10).
  const sampleMatches: string[] = [];
  for (const idx of matchSet) {
    if (sampleMatches.length >= MAX_SAMPLE_MATCHES) break;
    sampleMatches.push(nodeDisplayName(p, idx));
  }

  // Second pass: walk every node's edge slice (sequential layout) and
  // record retainers of matched nodes. The `to_node` field in V8 heap
  // snapshots is the FIRST-FIELD index into the flat `nodes` array — so
  // to get the logical node index we divide by `nodeFieldCount`.
  // Tracks: retainerNodeIdx → { edgesToMatches, sampleHeldNodes }.
  type RetainerAgg = { edgesToMatches: number; sampleHeldNodes: string[] };
  const retainerMap = new Map<number, RetainerAgg>();

  let edgeCursor = 0;
  for (let nodeIdx = 0; nodeIdx < nodeCount; nodeIdx++) {
    const nodeBase = nodeIdx * p.nodeFieldCount;
    const edgesOnThisNode = p.nodes[nodeBase + p.fieldIdx.nodeEdgeCount] ?? 0;
    for (let e = 0; e < edgesOnThisNode; e++) {
      const edgeBase = (edgeCursor + e) * p.edgeFieldCount;
      const toNodeRaw = p.edges[edgeBase + p.fieldIdx.edgeToNode] ?? 0;
      // toNodeRaw is in "first-field-index" units; convert to logical idx.
      const toNodeIdx = (toNodeRaw / p.nodeFieldCount) | 0;
      if (!matchSet.has(toNodeIdx)) continue;
      if (nodeIdx === toNodeIdx) continue; // skip self-edges
      let agg = retainerMap.get(nodeIdx);
      if (!agg) {
        agg = { edgesToMatches: 0, sampleHeldNodes: [] };
        retainerMap.set(nodeIdx, agg);
      }
      agg.edgesToMatches++;
      if (agg.sampleHeldNodes.length < MAX_SAMPLE_HELD) {
        agg.sampleHeldNodes.push(nodeDisplayName(p, toNodeIdx));
      }
    }
    edgeCursor += edgesOnThisNode;
  }

  // Materialise + sort by retainer self_size desc; tie-break by edgesToMatches desc.
  const rows: HeapRetainerRow[] = [];
  for (const [retainerIdx, agg] of retainerMap.entries()) {
    const base = retainerIdx * p.nodeFieldCount;
    const typeIdx = p.nodes[base + p.fieldIdx.nodeType] ?? 0;
    rows.push({
      retainerName: nodeDisplayName(p, retainerIdx),
      retainerType: p.nodeTypes[typeIdx] ?? "",
      retainerSelfSize: nodeSelfSize(p, retainerIdx),
      edgesToMatches: agg.edgesToMatches,
      sampleHeldNodes: agg.sampleHeldNodes,
    });
  }
  rows.sort((a, b) => {
    if (b.retainerSelfSize !== a.retainerSelfSize) return b.retainerSelfSize - a.retainerSelfSize;
    return b.edgesToMatches - a.edgesToMatches;
  });
  const retainers = rows.length > MAX_RETAINER_RESULTS ? rows.slice(0, MAX_RETAINER_RESULTS) : rows;

  const result: HeapRetainersResult = {
    summary,
    matchCount: matchSet.size,
    retainers,
    sampleMatches,
  };
  if (warnings.length) result.warnings = warnings;
  return result;
}
