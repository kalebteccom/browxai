import { describe, it, expect } from "vitest";
import { sampleMetric, ELEMENT_METRICS } from "./sample.js";

const fakePage = {} as never;
const fakeRefs = {} as never;

describe("sampleMetric — W-J3 bounded sampler", () => {
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
