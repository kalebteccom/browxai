import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PerfTracingState,
  DEFAULT_TRACE_CATEGORIES,
  extractInsights,
  writeTraceFile,
  readTraceFile,
  resolvePerfTracePath,
  defaultTracePath,
  type TraceEvent,
} from "./perf.js";

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

describe("PerfTracingState — start/stop lifecycle", () => {
  it("start enables CDP Tracing with default categories", async () => {
    const { cdp, calls } = fakeCdp();
    const state = new PerfTracingState();
    const r = await state.start(cdp as never);
    expect(r.restarted).toBe(false);
    expect(r.categories).toEqual(DEFAULT_TRACE_CATEGORIES);
    expect(state.isRunning()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("Tracing.start");
    const traceConfig = calls[0]!.params.traceConfig as { includedCategories: string[] };
    expect(traceConfig.includedCategories).toEqual(DEFAULT_TRACE_CATEGORIES);
  });

  it("start accepts custom categories", async () => {
    const { cdp, calls } = fakeCdp();
    const state = new PerfTracingState();
    await state.start(cdp as never, { categories: ["loading", "v8.execute"] });
    const traceConfig = calls[0]!.params.traceConfig as { includedCategories: string[] };
    expect(traceConfig.includedCategories).toEqual(["loading", "v8.execute"]);
  });

  it("stop buffers dataCollected events and resolves on tracingComplete", async () => {
    const { cdp } = fakeCdp();
    const state = new PerfTracingState();
    await state.start(cdp as never);
    // emit two batches then completion
    void state.stop(cdp as never).then(() => undefined);
    await cdp._emit("Tracing.dataCollected", {
      value: [
        { name: "A", ts: 1000 },
        { name: "B", ts: 2000 },
      ],
    });
    await cdp._emit("Tracing.dataCollected", { value: [{ name: "C", ts: 3000 }] });
    await cdp._emit("Tracing.tracingComplete", {});
    // The stop promise above is already resolved by tracingComplete; restart
    // sequence + assertions
    expect(state.isRunning()).toBe(false);
  });

  it("stop returns the buffered events and clears state", async () => {
    const { cdp } = fakeCdp();
    const state = new PerfTracingState();
    await state.start(cdp as never);
    const stopP = state.stop(cdp as never);
    await cdp._emit("Tracing.dataCollected", { value: [{ name: "A" }, { name: "B" }] });
    await cdp._emit("Tracing.tracingComplete", {});
    const r = await stopP;
    expect(r.notRunning).toBeUndefined();
    expect(r.events.map((e) => e.name)).toEqual(["A", "B"]);
    expect(state.isRunning()).toBe(false);
  });

  it("stop when not running returns notRunning:true (idempotent)", async () => {
    const { cdp } = fakeCdp();
    const state = new PerfTracingState();
    const r = await state.stop(cdp as never);
    expect(r.notRunning).toBe(true);
    expect(r.events).toEqual([]);
  });

  it("double start cleanly restarts: prior trace stopped, fresh start sent", async () => {
    const { cdp, calls } = fakeCdp();
    const state = new PerfTracingState();
    // First start
    await state.start(cdp as never);
    // Stub: simulate the tracingComplete that the inner restart-driven stop
    // is waiting for. We hook it via a side-channel: trigger one tick later.
    queueMicrotask(() => {
      void cdp._emit("Tracing.tracingComplete", {});
    });
    const r = await state.start(cdp as never, { categories: ["loading"] });
    expect(r.restarted).toBe(true);
    // The send sequence: Tracing.start, Tracing.end (clean), Tracing.start
    expect(calls.map((c) => c.method)).toEqual(["Tracing.start", "Tracing.end", "Tracing.start"]);
    expect(state.isRunning()).toBe(true);
  });

  it("closeIfRunning is a no-op when not running and tolerant when running", async () => {
    const { cdp } = fakeCdp();
    const state = new PerfTracingState();
    await state.closeIfRunning(cdp as never); // no-op
    expect(state.isRunning()).toBe(false);
    await state.start(cdp as never);
    queueMicrotask(() => {
      void cdp._emit("Tracing.tracingComplete", {});
    });
    await state.closeIfRunning(cdp as never);
    expect(state.isRunning()).toBe(false);
  });

  it("listeners are torn down after stop (no leak)", async () => {
    const { cdp } = fakeCdp();
    const state = new PerfTracingState();
    await state.start(cdp as never);
    expect(cdp._listenerCount("Tracing.dataCollected")).toBe(1);
    expect(cdp._listenerCount("Tracing.tracingComplete")).toBe(1);
    const stopP = state.stop(cdp as never);
    await cdp._emit("Tracing.tracingComplete", {});
    await stopP;
    expect(cdp._listenerCount("Tracing.dataCollected")).toBe(0);
    expect(cdp._listenerCount("Tracing.tracingComplete")).toBe(0);
  });
});

describe("extractInsights", () => {
  // chromium tracing emits ts in microseconds; we surface ms.
  const us = (ms: number): number => ms * 1000;

  it("extracts long tasks above the 50ms threshold, sorted longest-first", () => {
    const events: TraceEvent[] = [
      { name: "RunTask", ts: us(100), dur: us(120) },
      { name: "RunTask", ts: us(300), dur: us(30) }, // under threshold
      { name: "LongTask", ts: us(500), dur: us(80) },
    ];
    const r = extractInsights(events);
    expect(r.longTasks).toEqual([
      { startMs: 100, durationMs: 120 },
      { startMs: 500, durationMs: 80 },
    ]);
    expect(r.totals.longTaskCount).toBe(2);
  });

  it("extracts layout shifts and sums score", () => {
    const events: TraceEvent[] = [
      { name: "LayoutShift", ts: us(200), args: { data: { score: 0.05 } } },
      { name: "LayoutShift", ts: us(400), args: { data: { score: 0.15, had_recent_input: true } } },
    ];
    const r = extractInsights(events);
    expect(r.layoutShifts).toHaveLength(2);
    // sorted by score desc
    expect(r.layoutShifts[0]!.score).toBeCloseTo(0.15);
    expect(r.layoutShifts[0]!.hadRecentInput).toBe(true);
    expect(r.totals.layoutShiftScoreSum).toBeCloseTo(0.2);
  });

  it("pairs render-blocking ResourceSendRequest with ResourceFinish for duration", () => {
    const events: TraceEvent[] = [
      {
        name: "ResourceSendRequest",
        ts: us(100),
        args: {
          data: {
            requestId: "r1",
            url: "https://x/app.css",
            renderBlocking: "blocking",
            resourceType: "Stylesheet",
          },
        },
      },
      {
        name: "ResourceSendRequest",
        ts: us(150),
        args: {
          data: {
            requestId: "r2",
            url: "https://x/img.png",
            renderBlocking: "non_blocking_dynamic",
          },
        },
      },
      { name: "ResourceFinish", ts: us(550), args: { data: { requestId: "r1" } } },
      { name: "ResourceFinish", ts: us(600), args: { data: { requestId: "r2" } } },
    ];
    const r = extractInsights(events);
    expect(r.renderBlocking).toEqual([
      { url: "https://x/app.css", type: "Stylesheet", durationMs: 450 },
    ]);
  });

  it("collects LCP candidates", () => {
    const events: TraceEvent[] = [
      {
        name: "largestContentfulPaint::Candidate",
        ts: us(800),
        args: { data: { size: 1024, url: "https://x/hero.jpg" } },
      },
      { name: "largestContentfulPaint::Candidate", ts: us(1200), args: { data: { size: 4096 } } },
    ];
    const r = extractInsights(events);
    expect(r.lcpCandidates).toHaveLength(2);
    expect(r.lcpCandidates[0]!.startMs).toBe(800);
    expect(r.lcpCandidates[1]!.size).toBe(4096);
  });

  it("computes navigation milestones relative to navigationStart", () => {
    const events: TraceEvent[] = [
      { name: "navigationStart", ts: us(1000) },
      { name: "firstPaint", ts: us(1300) },
      { name: "firstContentfulPaint", ts: us(1450) },
      { name: "MarkDOMContent", ts: us(2000) },
      { name: "MarkLoad", ts: us(3500) },
    ];
    const r = extractInsights(events);
    expect(r.navigation).toEqual({
      navigationStartMs: 1000,
      firstPaintMs: 300,
      firstContentfulPaintMs: 450,
      domContentLoadedMs: 1000,
      loadEventMs: 2500,
    });
  });

  it("returns empty insights for an empty trace", () => {
    const r = extractInsights([]);
    expect(r.longTasks).toEqual([]);
    expect(r.layoutShifts).toEqual([]);
    expect(r.renderBlocking).toEqual([]);
    expect(r.lcpCandidates).toEqual([]);
    expect(r.totals.events).toBe(0);
  });

  it("ignores malformed events without crashing", () => {
    const events: TraceEvent[] = [
      { name: "RunTask" }, // no dur — falls under threshold
      { name: "", ts: us(10), dur: us(60) }, // empty name
      { args: { data: { score: 1 } } } as TraceEvent, // no name
      null as unknown as TraceEvent,
    ];
    const r = extractInsights(events);
    expect(r.longTasks).toEqual([]);
    expect(r.layoutShifts).toEqual([]);
  });
});

describe("trace file IO", () => {
  it("writes a chrome-tracing-shaped JSON file and reads it back", () => {
    const root = mkdtempSync(join(tmpdir(), "browx-perf-"));
    try {
      const events: TraceEvent[] = [
        { name: "A", ts: 100 },
        { name: "B", ts: 200 },
      ];
      const target = "perf-traces/test.json";
      const { resolved, bytes } = writeTraceFile(
        root,
        target,
        events,
        { categories: ["loading"], sessionId: "s1", durationMs: 1234 },
        "perf_stop",
      );
      expect(resolved.startsWith(root)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
      expect(existsSync(resolved)).toBe(true);
      const back = readTraceFile(root, target, "perf_insights");
      expect(back.events.map((e) => e.name)).toEqual(["A", "B"]);
      expect(back.metadata).toMatchObject({ source: "browxai", sessionId: "s1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects paths that escape the workspace root", () => {
    expect(() => resolvePerfTracePath("/tmp/ws", "../etc/passwd", "perf_stop")).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
    expect(() => resolvePerfTracePath("/tmp/ws", "/etc/passwd", "perf_stop")).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
  });

  it("defaultTracePath roots under <workspace>/perf-traces/ and sanitises session id", () => {
    const root = "/tmp/ws";
    const p = defaultTracePath(root, "weird/id with spaces");
    expect(p.startsWith(`${root}/perf-traces/`)).toBe(true);
    expect(p).not.toContain(" ");
    expect(p).not.toContain("/weird/");
  });

  it("readTraceFile tolerates a bare event-array file shape", () => {
    const root = mkdtempSync(join(tmpdir(), "browx-perf-"));
    try {
      const events: TraceEvent[] = [{ name: "X" }];
      const target = "perf-traces/legacy.json";
      // Write a bare array (some legacy tooling does this).
      writeTraceFile(
        root,
        target,
        events,
        { categories: [], sessionId: "s", durationMs: 0 },
        "perf_stop",
      );
      // Now manually replace with a bare-array file to test the reader's tolerance.
      const path = `${root}/perf-traces/legacy.json`;
      // Use only fs APIs here (test scaffolding — not the no-trace src/ path).
      writeFileSync(path, JSON.stringify(events));
      const back = readTraceFile(root, target, "perf_insights");
      expect(back.events.map((e) => e.name)).toEqual(["X"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
