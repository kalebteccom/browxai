import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  takeHeapSnapshot,
  resolveHeapSnapshotPath,
  defaultHeapSnapshotPath,
  writeHeapSnapshotFile,
  parseHeapSnapshot,
  queryRetainers,
  readHeapSnapshotFile,
} from "./heap.js";

type CdpCall = { method: string; params: Record<string, unknown> };

function fakeCdp() {
  const calls: CdpCall[] = [];
  const handlers: Record<string, Array<(arg: unknown) => unknown>> = {};
  const cdp = {
    send: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    }),
    on: vi.fn((event: string, h: (arg: unknown) => unknown) => {
      (handlers[event] ??= []).push(h);
    }),
    off: vi.fn((event: string, h: (arg: unknown) => unknown) => {
      const list = handlers[event];
      if (!list) return;
      const i = list.indexOf(h);
      if (i >= 0) list.splice(i, 1);
    }),
    _emit: async (event: string, arg: unknown): Promise<void> => {
      for (const h of [...(handlers[event] ?? [])]) await h(arg);
    },
    _listenerCount: (event: string): number => (handlers[event] ?? []).length,
  };
  return { cdp, calls };
}

// Build a tiny but spec-valid V8 heap snapshot JSON in-memory. Three nodes:
//   0: object "Window"      (size 100), 1 edge -> node 1
//   1: object "Cache"       (size 50),  2 edges -> node 2, -> node 2
//   2: object "LeakyItem"   (size 20),  0 edges
//
// Node fields layout (canonical V8 order):
//   type, name, id, self_size, edge_count, trace_node_id, detachedness
// Edge fields: type, name_or_index, to_node
// to_node values are FIRST-FIELD INDEX into the flat `nodes` array (V8 quirk):
//   node 0 → 0, node 1 → 7, node 2 → 14   (nodeFieldCount = 7)
function makeFixtureSnapshot(): string {
  const nodeFields = ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"];
  const edgeFields = ["type", "name_or_index", "to_node"];
  const nodeTypes = ["hidden", "object", "closure", "string"];
  const edgeTypes = ["context", "element", "property", "internal"];
  // strings index map: 0:"", 1:"Window", 2:"Cache", 3:"LeakyItem", 4:"items", 5:"second"
  const strings = ["", "Window", "Cache", "LeakyItem", "items", "second"];
  // type indices: "object" = 1
  // node 0: Window @ first-field-idx 0
  // node 1: Cache  @ first-field-idx 7
  // node 2: LeakyItem @ first-field-idx 14
  const nodes = [
    /* node 0 Window    */ 1, 1, 1, 100, 1, 0, 0,
    /* node 1 Cache     */ 1, 2, 2,  50, 2, 0, 0,
    /* node 2 LeakyItem */ 1, 3, 3,  20, 0, 0, 0,
  ];
  // edges, in node order:
  //   from node 0: -> node 1 (idx 7)
  //   from node 1: -> node 2 (idx 14), -> node 2 (idx 14)
  const edges = [
    /* Window -> Cache  */ 2, 4, 7,
    /* Cache  -> Leaky  */ 2, 4, 14,
    /* Cache  -> Leaky  */ 2, 5, 14,
  ];
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: nodeFields,
        node_types: [nodeTypes, "string", "number", "number", "number", "number", "number"],
        edge_fields: edgeFields,
        edge_types: [edgeTypes, "string_or_number", "node"],
      },
      node_count: 3,
      edge_count: 3,
    },
    nodes,
    edges,
    strings,
  });
}

describe("takeHeapSnapshot — CDP plumbing", () => {
  it("requests HeapProfiler.takeHeapSnapshot and concatenates chunks", async () => {
    const { cdp, calls } = fakeCdp();
    // The fake CDP doesn't actually call `taken` after send; we have to
    // emit chunks before `send` resolves. Easiest: pre-stub send to emit.
    cdp.send = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "HeapProfiler.takeHeapSnapshot") {
        await cdp._emit("HeapProfiler.addHeapSnapshotChunk", { chunk: '{"snap' });
        await cdp._emit("HeapProfiler.addHeapSnapshotChunk", { chunk: 'shot":1}' });
      }
      return {};
    });
    const out = await takeHeapSnapshot(cdp as never);
    expect(out).toBe('{"snapshot":1}');
    expect(calls.map((c) => c.method)).toEqual(["HeapProfiler.takeHeapSnapshot"]);
    expect(calls[0]!.params).toMatchObject({ reportProgress: false });
  });

  it("detaches the chunk listener even when the take call throws", async () => {
    const { cdp } = fakeCdp();
    cdp.send = vi.fn(async () => { throw new Error("boom"); });
    await expect(takeHeapSnapshot(cdp as never)).rejects.toThrow("boom");
    expect(cdp._listenerCount("HeapProfiler.addHeapSnapshotChunk")).toBe(0);
  });

  it("detaches the chunk listener on success (no leak across calls)", async () => {
    const { cdp } = fakeCdp();
    cdp.send = vi.fn(async () => {
      await cdp._emit("HeapProfiler.addHeapSnapshotChunk", { chunk: "x" });
      return {};
    });
    await takeHeapSnapshot(cdp as never);
    expect(cdp._listenerCount("HeapProfiler.addHeapSnapshotChunk")).toBe(0);
  });
});

describe("workspace path enforcement", () => {
  it("resolveHeapSnapshotPath: rejects paths that escape the workspace", () => {
    const root = "/tmp/wsX";
    expect(() => resolveHeapSnapshotPath(root, "../outside.heapsnapshot", "heap_snapshot"))
      .toThrow(/must resolve inside \$BROWX_WORKSPACE/);
  });

  it("resolveHeapSnapshotPath: accepts paths inside the workspace", () => {
    const root = "/tmp/wsX";
    expect(resolveHeapSnapshotPath(root, "heap-snapshots/x.heapsnapshot", "heap_snapshot"))
      .toBe("/tmp/wsX/heap-snapshots/x.heapsnapshot");
  });

  it("defaultHeapSnapshotPath: sessionId is sanitised + ISO timestamp", () => {
    const p = defaultHeapSnapshotPath("/tmp/ws", "agent/A?");
    expect(p).toMatch(/^\/tmp\/ws\/heap-snapshots\/agent_A_-\d{4}-\d{2}-\d{2}T/);
    expect(p.endsWith(".heapsnapshot")).toBe(true);
  });

  it("writeHeapSnapshotFile: creates the parent dir + writes the JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "browx-heap-"));
    try {
      const target = join(root, "heap-snapshots", "x.heapsnapshot");
      const r = writeHeapSnapshotFile(root, target, '{"snapshot":1}', "heap_snapshot");
      expect(existsSync(target)).toBe(true);
      expect(r.bytes).toBe(Buffer.byteLength('{"snapshot":1}', "utf8"));
      expect(readFileSync(target, "utf8")).toBe('{"snapshot":1}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseHeapSnapshot", () => {
  it("rejects non-JSON input", () => {
    expect(() => parseHeapSnapshot("not json")).toThrow(/not valid JSON/);
  });

  it("rejects missing snapshot.meta.node_fields", () => {
    expect(() => parseHeapSnapshot(JSON.stringify({ snapshot: {} })))
      .toThrow(/node_fields/);
  });

  it("rejects when nodes/edges/strings are missing", () => {
    const bad = JSON.stringify({
      snapshot: { meta: { node_fields: ["type"], edge_fields: ["type"] } },
    });
    expect(() => parseHeapSnapshot(bad)).toThrow(/nodes \/ edges \/ strings/);
  });

  it("rejects when a required field is missing from meta", () => {
    const bad = JSON.stringify({
      snapshot: { meta: {
        node_fields: ["type", "name"], // missing self_size etc.
        edge_fields: ["type", "name_or_index", "to_node"],
      } },
      nodes: [], edges: [], strings: [],
    });
    expect(() => parseHeapSnapshot(bad)).toThrow(/required field/);
  });

  it("parses a valid snapshot", () => {
    const p = parseHeapSnapshot(makeFixtureSnapshot());
    expect(p.nodeFieldCount).toBe(7);
    expect(p.edgeFieldCount).toBe(3);
    expect(p.nodes.length).toBe(21); // 3 nodes * 7 fields
    expect(p.edges.length).toBe(9);  // 3 edges * 3 fields
    expect(p.strings.length).toBe(6);
  });
});

describe("queryRetainers", () => {
  it("requires at least one of name/type", () => {
    const p = parseHeapSnapshot(makeFixtureSnapshot());
    expect(() => queryRetainers(p, {})).toThrow(/at least one of/);
  });

  it("matches by exact name and finds its retainer", () => {
    const p = parseHeapSnapshot(makeFixtureSnapshot());
    const r = queryRetainers(p, { name: "LeakyItem" });
    expect(r.matchCount).toBe(1);
    expect(r.sampleMatches).toEqual(["object:LeakyItem"]);
    // Cache holds LeakyItem with 2 edges; that's the only retainer.
    expect(r.retainers).toHaveLength(1);
    expect(r.retainers[0]!.retainerName).toBe("object:Cache");
    expect(r.retainers[0]!.edgesToMatches).toBe(2);
    expect(r.retainers[0]!.retainerSelfSize).toBe(50);
    // Two edges from Cache → LeakyItem produce two sample entries (cap is 5).
    expect(r.retainers[0]!.sampleHeldNodes).toEqual(["object:LeakyItem", "object:LeakyItem"]);
  });

  it("matches by substring when nameMatch is `substring`", () => {
    const p = parseHeapSnapshot(makeFixtureSnapshot());
    const r = queryRetainers(p, { name: "Leak", nameMatch: "substring" });
    expect(r.matchCount).toBe(1);
    expect(r.retainers[0]!.retainerName).toBe("object:Cache");
  });

  it("returns zero retainers for a name that doesn't match anything", () => {
    const p = parseHeapSnapshot(makeFixtureSnapshot());
    const r = queryRetainers(p, { name: "DoesNotExist" });
    expect(r.matchCount).toBe(0);
    expect(r.retainers).toEqual([]);
    expect(r.sampleMatches).toEqual([]);
  });

  it("matches by type filter alone", () => {
    const p = parseHeapSnapshot(makeFixtureSnapshot());
    const r = queryRetainers(p, { type: "object" });
    // All 3 fixture nodes are type:object. Window has no retainer (root).
    // Cache is retained by Window. LeakyItem is retained by Cache.
    expect(r.matchCount).toBe(3);
    const names = r.retainers.map((row) => row.retainerName);
    expect(names).toContain("object:Window");
    expect(names).toContain("object:Cache");
  });

  it("composes name + type — both must match", () => {
    const p = parseHeapSnapshot(makeFixtureSnapshot());
    const r = queryRetainers(p, { name: "LeakyItem", type: "object" });
    expect(r.matchCount).toBe(1);
    // wrong type → no match.
    const r2 = queryRetainers(p, { name: "LeakyItem", type: "closure" });
    expect(r2.matchCount).toBe(0);
  });

  it("summary totals reflect all nodes regardless of match", () => {
    const p = parseHeapSnapshot(makeFixtureSnapshot());
    const r = queryRetainers(p, { name: "LeakyItem" });
    expect(r.summary.nodeCount).toBe(3);
    expect(r.summary.edgeCount).toBe(3);
    expect(r.summary.totalSelfSize).toBe(170); // 100 + 50 + 20
  });
});

describe("readHeapSnapshotFile", () => {
  it("round-trips a written snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "browx-heap-"));
    try {
      const target = join(root, "heap-snapshots", "x.heapsnapshot");
      writeHeapSnapshotFile(root, target, makeFixtureSnapshot(), "heap_snapshot");
      const { parsed, resolved } = readHeapSnapshotFile(root, target, "heap_retainers");
      expect(resolved).toBe(target);
      expect(parsed.nodes.length).toBe(21);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws a helpful error when the file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "browx-heap-"));
    try {
      expect(() => readHeapSnapshotFile(root, "missing.heapsnapshot", "heap_retainers"))
        .toThrow(/snapshot file not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
