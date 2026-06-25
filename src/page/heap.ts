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

// Public surface preserved at this path: the `.heapsnapshot` on-disk helpers
// (path guard, default-path, write/read) and the pure parse + retainer query
// now live in a sibling leaf (heap-parse.ts), but every importer + colocated
// test still resolves them through `heap.js`. heap.ts itself owns only the CDP
// snapshot lifecycle below — `memory-diff.ts` reuses the parser without
// dragging in CDP state.
export {
  resolveHeapSnapshotPath,
  defaultHeapSnapshotPath,
  writeHeapSnapshotFile,
  parseHeapSnapshot,
  readHeapSnapshotFile,
  queryRetainers,
} from "./heap-parse.js";
export type {
  HeapSnapshotSummary,
  HeapRetainerRow,
  HeapRetainersResult,
  HeapRetainersQuery,
} from "./heap-parse.js";

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
