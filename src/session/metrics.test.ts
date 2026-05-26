import { describe, it, expect } from "vitest";
import { SessionMetrics } from "./metrics.js";

describe("SessionMetrics", () => {
  it("starts empty with the session start anchored at construction time", () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const m = new SessionMetrics(t0);
    const snap = m.snapshot(t0 + 1000);
    expect(snap.callsByTool).toEqual({});
    expect(snap.durationMsByTool).toEqual({});
    expect(snap.errorsByTool).toEqual({});
    expect(snap.tokensEstimateSum).toBe(0);
    expect(snap.capabilityDenials).toBe(0);
    expect(snap.sessionStartedAt).toBe(new Date(t0).toISOString());
    expect(snap.sessionDurationMs).toBe(1000);
  });

  it("accumulates per-tool count + duration across ok dispatches", () => {
    const m = new SessionMetrics(0);
    m.record("snapshot", "ok", 12, 80);
    m.record("snapshot", "ok", 8, 100);
    m.record("find", "ok", 30, 40);
    const snap = m.snapshot(100);
    expect(snap.callsByTool).toEqual({ snapshot: 2, find: 1 });
    expect(snap.durationMsByTool).toEqual({ snapshot: 20, find: 30 });
    expect(snap.tokensEstimateSum).toBe(220);
    expect(snap.errorsByTool).toEqual({}); // ok-only run: no entry, not a 0
  });

  it("buckets errors per tool; denials are session-wide, not per-tool", () => {
    const m = new SessionMetrics(0);
    m.record("click", "error", 5, 30);
    m.record("click", "error", 6, 30);
    m.record("click", "ok", 7, 30);
    m.record("eval_js", "denied", 1, 50);
    m.record("eval_js", "denied", 1, 50);
    const snap = m.snapshot(0);
    expect(snap.callsByTool).toEqual({ click: 3, eval_js: 2 });
    expect(snap.errorsByTool).toEqual({ click: 2 });
    expect(snap.capabilityDenials).toBe(2);
    // denied dispatches contribute to count + duration but NOT to errorsByTool
    expect(snap.durationMsByTool.eval_js).toBe(2);
  });

  it("tolerates a missing tokensEstimate (image-only / non-JSON result)", () => {
    const m = new SessionMetrics(0);
    m.record("screenshot", "ok", 50);
    m.record("snapshot", "ok", 20, 1000);
    const snap = m.snapshot(0);
    expect(snap.callsByTool).toEqual({ screenshot: 1, snapshot: 1 });
    expect(snap.tokensEstimateSum).toBe(1000);
  });

  it("ignores a non-finite tokensEstimate (defensive against NaN sums)", () => {
    const m = new SessionMetrics(0);
    m.record("snapshot", "ok", 10, Number.NaN);
    m.record("snapshot", "ok", 10, Number.POSITIVE_INFINITY);
    m.record("snapshot", "ok", 10, 42);
    expect(m.snapshot(0).tokensEstimateSum).toBe(42);
  });

  it("clamps a negative duration to zero (defensive against clock skew)", () => {
    const m = new SessionMetrics(0);
    m.record("snapshot", "ok", -5, 0);
    expect(m.snapshot(0).durationMsByTool.snapshot).toBe(0);
  });

  it("snapshot is a pure read — taking two in a row yields the same shape", () => {
    const m = new SessionMetrics(0);
    m.record("snapshot", "ok", 10, 100);
    const a = m.snapshot(50);
    const b = m.snapshot(50);
    expect(a).toEqual(b);
  });

  it("sessionDurationMs floors at zero when `now` precedes startedAt", () => {
    const m = new SessionMetrics(1000);
    expect(m.snapshot(500).sessionDurationMs).toBe(0);
  });
});
