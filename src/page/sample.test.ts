import { describe, it, expect } from "vitest";
import { sampleMetric, ELEMENT_METRICS, summariseSeries } from "./sample.js";

const fakePage = {} as never;
const fakeRefs = {} as never;

describe("sampleMetric — bounded sampler", () => {
  it("rejects bbox* metrics when there is no target (meaningless for window)", async () => {
    for (const m of ["bboxX", "bboxY", "bboxWidth", "bboxHeight"] as const) {
      await expect(
        sampleMetric(fakePage, fakeRefs, { metric: m, durationMs: 100 }),
      ).rejects.toThrow(/needs a target element/);
    }
  });

  it("the metric enum is the fixed whitelist (no arbitrary expression escape)", () => {
    // Guard: the enum must never include a free-form 'expr'-like member.
    expect([...ELEMENT_METRICS]).toEqual([
      "scrollTop", "scrollLeft", "scrollHeight", "scrollWidth",
      "clientWidth", "clientHeight",
      "bboxX", "bboxY", "bboxWidth", "bboxHeight",
    ]);
    expect(ELEMENT_METRICS).not.toContain("expr");
  });

  it("window scroll metrics are allowed without a target (validation passes the gate)", async () => {
    // No target + a non-bbox metric must NOT throw the bbox guard. It will
    // still fail later when it touches the fake page — but not with the
    // bbox-needs-target error. We assert the gate specifically.
    await expect(
      sampleMetric(fakePage, fakeRefs, { metric: "scrollTop", durationMs: 50 }),
    ).rejects.not.toThrow(/needs a target element/);
  });
});

describe("summariseSeries — reducer", () => {
  it("reduces a flat series (no change → firstChangeTMs null, distinctCount 1)", () => {
    const s = [0, 100, 200, 300].map((tMs) => ({ tMs, value: 6500 }));
    expect(summariseSeries(s)).toEqual({
      count: 4, min: 6500, max: 6500, first: 6500, last: 6500,
      distinctCount: 1, firstChangeTMs: null,
    });
  });

  it("captures bounds + the tMs of the first deviation from `first`", () => {
    const s = [
      { tMs: 0, value: 10 },
      { tMs: 16, value: 10 },
      { tMs: 32, value: 14 },   // first change
      { tMs: 48, value: 9 },    // new min, but firstChange already set
    ];
    const r = summariseSeries(s);
    expect(r.first).toBe(10);
    expect(r.last).toBe(9);
    expect(r.min).toBe(9);
    expect(r.max).toBe(14);
    expect(r.distinctCount).toBe(3);
    expect(r.firstChangeTMs).toBe(32);
  });

  it("handles an empty series without throwing", () => {
    const r = summariseSeries([]);
    expect(r.count).toBe(0);
    expect(r.distinctCount).toBe(0);
    expect(r.firstChangeTMs).toBeNull();
  });
});
