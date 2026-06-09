// Dep-graph builder — cycle detection + topo sort + transitive closures.

import { describe, it, expect } from "vitest";
import { buildDepGraph, DepGraphCycleError } from "./depgraph.js";

describe("buildDepGraph", () => {
  it("handles an empty graph", () => {
    const r = buildDepGraph({ directDeps: new Map() });
    expect(r.loadOrder).toEqual([]);
    expect(r.transitiveDeps.size).toBe(0);
  });

  it("handles disconnected single-node graphs", () => {
    const r = buildDepGraph({
      directDeps: new Map([
        ["a", []],
        ["b", []],
      ]),
    });
    expect(new Set(r.loadOrder)).toEqual(new Set(["a", "b"]));
    expect([...(r.transitiveDeps.get("a") ?? [])]).toEqual([]);
    expect([...(r.transitiveDeps.get("b") ?? [])]).toEqual([]);
  });

  it("topo-sorts deps before dependents", () => {
    const r = buildDepGraph({
      directDeps: new Map([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", []],
      ]),
    });
    expect(r.loadOrder).toEqual(["c", "b", "a"]);
  });

  it("computes transitive deps", () => {
    const r = buildDepGraph({
      directDeps: new Map([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", []],
      ]),
    });
    expect([...(r.transitiveDeps.get("a") ?? [])].sort()).toEqual(["b", "c"]);
    expect([...(r.transitiveDeps.get("b") ?? [])].sort()).toEqual(["c"]);
    expect([...(r.transitiveDeps.get("c") ?? [])]).toEqual([]);
  });

  it("rejects a simple two-node cycle loudly", () => {
    try {
      buildDepGraph({
        directDeps: new Map([
          ["a", ["b"]],
          ["b", ["a"]],
        ]),
      });
      throw new Error("expected DepGraphCycleError");
    } catch (e) {
      expect(e).toBeInstanceOf(DepGraphCycleError);
      const err = e as DepGraphCycleError;
      expect(err.cycles.length).toBe(1);
      const cycle = err.cycles[0]!;
      expect(new Set(cycle)).toEqual(new Set(["a", "b"]));
      expect(err.message).toMatch(/cycle/i);
    }
  });

  it("rejects a three-node cycle", () => {
    expect(() =>
      buildDepGraph({
        directDeps: new Map([
          ["a", ["b"]],
          ["b", ["c"]],
          ["c", ["a"]],
        ]),
      }),
    ).toThrow(DepGraphCycleError);
  });

  it("reports every plugin in a cycle", () => {
    try {
      buildDepGraph({
        directDeps: new Map([
          ["a", ["b"]],
          ["b", ["c"]],
          ["c", ["a"]],
        ]),
      });
      throw new Error("expected DepGraphCycleError");
    } catch (e) {
      expect(e).toBeInstanceOf(DepGraphCycleError);
      const cycle = (e as DepGraphCycleError).cycles[0]!;
      expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
    }
  });

  it("tolerates self-edges (they're not cycles)", () => {
    const r = buildDepGraph({
      directDeps: new Map([
        ["a", ["a"]],
        ["b", []],
      ]),
    });
    expect(new Set(r.loadOrder)).toEqual(new Set(["a", "b"]));
  });

  it("tolerates edges pointing at unknown plugins", () => {
    const r = buildDepGraph({
      directDeps: new Map([
        ["a", ["non-existent"]],
        ["b", []],
      ]),
    });
    expect(new Set(r.loadOrder)).toEqual(new Set(["a", "b"]));
    // The transitive closure ignores the missing dep.
    expect([...(r.transitiveDeps.get("a") ?? [])]).toEqual([]);
  });

  it("produces a deterministic load order across runs", () => {
    const input = {
      directDeps: new Map([
        ["zeta", []],
        ["alpha", []],
        ["beta", ["alpha"]],
      ]),
    };
    const r1 = buildDepGraph(input);
    const r2 = buildDepGraph(input);
    expect(r1.loadOrder).toEqual(r2.loadOrder);
  });
});
