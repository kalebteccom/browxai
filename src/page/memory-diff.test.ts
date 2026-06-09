import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateNodeSizes, diffSizeMaps, diffHeapSnapshots } from "./memory-diff.js";
import { parseHeapSnapshot } from "./heap.js";

/** Synthesise a tiny but spec-valid V8 heap snapshot. `groups` is a list of
 *  {type, name, count, size} tuples — for each, `count` nodes of `size`
 *  bytes named `name`/typed `type` are emitted. No edges (we don't need
 *  them — memory_diff only sums self_size by group). */
function makeFixture(
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
  // Type index map. "object"=0, "closure"=1, "hidden"=2, "string"=3.
  const nodeTypes = ["object", "closure", "hidden", "string"];
  const edgeTypes = ["context", "element"];
  // Build strings array — index 0 = "" sentinel.
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
    if (typeIdx < 0) throw new Error(`unknown type ${g.type}`);
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

describe("aggregateNodeSizes", () => {
  it("groups by type:name and sums self_size", () => {
    const parsed = parseHeapSnapshot(
      makeFixture([
        { type: "object", name: "Cache", count: 3, size: 100 },
        { type: "object", name: "LeakyItem", count: 5, size: 200 },
      ]),
    );
    const m = aggregateNodeSizes(parsed);
    expect(m.get("object:Cache")?.size).toBe(300);
    expect(m.get("object:LeakyItem")?.size).toBe(1000);
  });
});

describe("diffSizeMaps", () => {
  it("reports retainer growth + drops sub-KB noise", () => {
    const before = new Map([
      ["object:Cache", { type: "object", name: "Cache", size: 1_000 }],
      ["object:Noise", { type: "object", name: "Noise", size: 500 }],
    ]);
    const after = new Map([
      ["object:Cache", { type: "object", name: "Cache", size: 5_000 }],
      ["object:Noise", { type: "object", name: "Noise", size: 700 }], // delta 200 — under noise floor
      ["object:NewLeak", { type: "object", name: "NewLeak", size: 20_000 }],
    ]);
    const r = diffSizeMaps(before, after);
    const nodes = r.retainerGrowth.map((g) => g.node);
    expect(nodes).toContain("object:Cache");
    expect(nodes).toContain("object:NewLeak");
    expect(nodes).not.toContain("object:Noise"); // dropped — sub-KB delta
    const cache = r.retainerGrowth.find((g) => g.node === "object:Cache")!;
    expect(cache.sizeBefore).toBe(1000);
    expect(cache.sizeAfter).toBe(5000);
    expect(cache.deltaBytes).toBe(4000);
    expect(cache.deltaPercent).toBe(400);
    // NewLeak: sizeBefore:0 — deltaPercent surfaces as "+inf" string.
    const newLeak = r.retainerGrowth.find((g) => g.node === "object:NewLeak")!;
    expect(newLeak.deltaPercent).toBe("+inf");
  });

  it("summarises totalGrowth + top3Growers sorted desc", () => {
    const before = new Map<string, { type: string; name: string; size: number }>();
    const after = new Map([
      ["a", { type: "object", name: "a", size: 3000 }],
      ["b", { type: "object", name: "b", size: 10_000 }],
      ["c", { type: "object", name: "c", size: 2_000 }],
      ["d", { type: "object", name: "d", size: 5_000 }],
    ]);
    const r = diffSizeMaps(before, after);
    expect(r.summary.totalGrowth).toBe(20_000);
    expect(r.summary.top3Growers.map((g) => g.node)).toEqual(["b", "d", "a"]);
  });
});

describe("diffHeapSnapshots — file IO + workspace escape rejection", () => {
  it("diffs two valid snapshot files on disk", () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "browx-memdiff-"));
    try {
      const before = join(wsRoot, "before.heapsnapshot");
      const after = join(wsRoot, "after.heapsnapshot");
      writeFileSync(before, makeFixture([{ type: "object", name: "Cache", count: 1, size: 1000 }]));
      writeFileSync(
        after,
        makeFixture([
          { type: "object", name: "Cache", count: 1, size: 5000 },
          { type: "object", name: "NewLeak", count: 1, size: 3000 },
        ]),
      );
      const r = diffHeapSnapshots(wsRoot, "before.heapsnapshot", "after.heapsnapshot");
      const cache = r.retainerGrowth.find((g) => g.node === "object:Cache")!;
      expect(cache.deltaBytes).toBe(4000);
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("rejects workspace-escape on either path", () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "browx-memdiff-"));
    try {
      expect(() => diffHeapSnapshots(wsRoot, "../../etc/passwd", "after")).toThrow(
        /must resolve inside \$BROWX_WORKSPACE/,
      );
      expect(() => diffHeapSnapshots(wsRoot, "before", "../../etc/passwd")).toThrow(
        /must resolve inside \$BROWX_WORKSPACE/,
      );
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("rejects missing file with structured error", () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "browx-memdiff-"));
    try {
      expect(() =>
        diffHeapSnapshots(wsRoot, "nope-before.heapsnapshot", "nope-after.heapsnapshot"),
      ).toThrow(/beforePath not found/);
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
