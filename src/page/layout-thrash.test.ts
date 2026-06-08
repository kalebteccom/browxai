import { describe, it, expect } from "vitest";
import { aggregateLayoutThrash } from "./layout-thrash.js";
import type { TraceEvent } from "./perf.js";

describe("aggregateLayoutThrash", () => {
  it("counts forced layouts + shifts + aggregates by stack", () => {
    const events: TraceEvent[] = [
      {
        name: "Layout",
        ts: 1000,
        dur: 2000,
        args: { data: { stackTrace: [{ functionName: "thrash", url: "app.js", lineNumber: 10, columnNumber: 5 }] } },
      },
      {
        name: "Layout",
        ts: 4000,
        dur: 3000,
        args: { data: { stackTrace: [{ functionName: "thrash", url: "app.js", lineNumber: 10, columnNumber: 5 }] } },
      },
      {
        name: "LayoutShift",
        ts: 5000,
        dur: 100,
        args: { data: {} },
      },
      {
        name: "ForcedSyncLayout",
        ts: 6000,
        dur: 500,
        args: { data: { stackTrace: [{ functionName: "other", url: "lib.js", lineNumber: 1, columnNumber: 1 }] } },
      },
    ];
    const r = aggregateLayoutThrash(events);
    expect(r.forcedLayoutsCount).toBe(3);
    expect(r.layoutShiftsCount).toBe(1);
    expect(r.eventsByOrigin.length).toBeGreaterThanOrEqual(2);
    const thrashOrigin = r.eventsByOrigin.find((o) => o.originatingStack.includes("thrash"));
    expect(thrashOrigin).toBeDefined();
    expect(thrashOrigin!.count).toBe(2);
    // 2000us + 3000us = 5000us = 5ms
    expect(thrashOrigin!.totalDurationMs).toBe(5);
  });

  it("uses <anonymous> when no stack present", () => {
    const r = aggregateLayoutThrash([
      { name: "ForcedSyncLayout", ts: 100, dur: 200, args: {} },
    ]);
    expect(r.forcedLayoutsCount).toBe(1);
    expect(r.eventsByOrigin[0]!.originatingStack).toBe("<anonymous>");
  });

  it("ignores unrelated events", () => {
    const r = aggregateLayoutThrash([
      { name: "RunTask", ts: 100, dur: 50_000, args: {} },
      { name: "Paint", ts: 200, dur: 100, args: {} },
    ]);
    expect(r.forcedLayoutsCount).toBe(0);
    expect(r.layoutShiftsCount).toBe(0);
    expect(r.eventsByOrigin).toHaveLength(0);
  });

  it("sorts origins by count desc", () => {
    const events: TraceEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push({
        name: "ForcedSyncLayout", ts: i * 100, dur: 10,
        args: { data: { stackTrace: [{ functionName: "loud" }] } },
      });
    }
    events.push({
      name: "ForcedSyncLayout", ts: 1000, dur: 10,
      args: { data: { stackTrace: [{ functionName: "quiet" }] } },
    });
    const r = aggregateLayoutThrash(events);
    expect(r.eventsByOrigin[0]!.originatingStack).toContain("loud");
    expect(r.eventsByOrigin[0]!.count).toBe(5);
  });
});
