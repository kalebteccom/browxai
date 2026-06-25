// Performance tracing — capability `action` (writes a file).
//
// "This click took 4s — why?" has no diagnostic surface in browxai's read-only
// tools: a screenshot/snapshot/network slice shows *what* happened, not *why*
// it was slow. CDP `Tracing.start` / `Tracing.end` produces a chromium trace
// blob that's the same shape Lighthouse / DevTools Performance consume; this
// module wraps it as a per-session lifecycle and pairs it with a minimal
// insights extractor over the resulting JSON so the agent gets a structured
// summary (long tasks, layout shifts, render-blocking resources, LCP /
// navigation timing candidates) without having to ship a megabyte of trace
// back through the MCP channel.
//
// Lifecycle (per session):
//   - perf_start({categories?})  → enables tracing on the CDP target.
//   - perf_stop({path?})         → flushes events to a workspace-rooted file
//                                  (default `<workspace>/perf-traces/<id>-<ts>.json`),
//                                  returns the path + a tiny inline summary.
//                                  Always idempotent: a second `perf_stop`
//                                  without a matching `perf_start` returns
//                                  `notRunning:true`, not an error.
//   - perf_insights({tracePath}) → reads the trace JSON and returns
//                                  structured insights.
//
// Idempotency guarantee (invariant 6): `perf_start` while a trace is already
// running first cleanly stops the in-flight one (events discarded) before
// starting fresh, so an agent that lost track of state can always recover by
// just calling `perf_start` again. `perf_stop` is safe to call any number of
// times.

import type { CDPSession } from "playwright-core";
import { DEFAULT_TRACE_CATEGORIES, type TraceEvent } from "./perf-trace-io.js";

// Public surface preserved at this path: the trace-I/O helpers and the pure
// insights extractor now live in sibling leaves (perf-trace-io.ts,
// perf-insights.ts) but every importer + colocated test still resolves them
// through `perf.js`. perf.ts itself owns only the CDP tracing lifecycle below.
export {
  DEFAULT_TRACE_CATEGORIES,
  resolvePerfTracePath,
  defaultTracePath,
  writeTraceFile,
  readTraceFile,
} from "./perf-trace-io.js";
export type { TraceEvent } from "./perf-trace-io.js";
export { extractInsights } from "./perf-insights.js";
export type { PerfInsights } from "./perf-insights.js";

/** Per-session trace state machine. One instance per SessionEntry. */
export class PerfTracingState {
  private running = false;
  private events: TraceEvent[] = [];
  /** Hook teardowns from the most recent `start`. */
  private listeners: Array<() => void> = [];
  /** Resolved-when the in-flight `Tracing.end` flushes all events. */
  private completePromise: Promise<void> | null = null;
  private completeResolve: (() => void) | null = null;
  /** Categories the current/last trace was started with — surfaced on stop. */
  private categories: string[] = [];
  private startedAt = 0;

  /** True iff a trace is currently being collected. */
  isRunning(): boolean {
    return this.running;
  }

  /** Start tracing on `cdp`. If a trace is already running, stops it cleanly
   *  first (events discarded) — guarantees the caller never gets stuck in a
   *  "tracing already started" CDP error from a stale start. */
  async start(
    cdp: CDPSession,
    opts: { categories?: string[] } = {},
  ): Promise<{ categories: string[]; restarted: boolean }> {
    let restarted = false;
    if (this.running) {
      restarted = true;
      // Clean restart: stop the in-flight trace; throw away its events.
      await this.stopInternal(cdp).catch(() => undefined);
    }
    const categories =
      opts.categories && opts.categories.length > 0 ? opts.categories : DEFAULT_TRACE_CATEGORIES;
    this.events = [];
    this.categories = [...categories];
    this.startedAt = Date.now();

    const onData = (e: { value: TraceEvent[] }) => {
      if (Array.isArray(e?.value)) {
        for (const ev of e.value) this.events.push(ev);
      }
    };
    const onComplete = () => {
      if (this.completeResolve) this.completeResolve();
    };
    cdp.on("Tracing.dataCollected", onData);
    cdp.on("Tracing.tracingComplete", onComplete);
    this.listeners = [
      () => cdp.off("Tracing.dataCollected", onData),
      () => cdp.off("Tracing.tracingComplete", onComplete),
    ];

    // Tracing.start with traceConfig — pass `includedCategories` for fine
    // control. CDP also accepts a comma-separated `categories` string for
    // legacy; the typed `traceConfig` is the supported shape.
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        recordMode: "recordContinuously",
        includedCategories: [...categories],
      },
    });
    this.running = true;
    return { categories: [...categories], restarted };
  }

  /** Stop tracing and return the buffered events. Safe to call when no trace
   *  is running — returns `notRunning:true` with an empty event list. */
  async stop(cdp: CDPSession): Promise<{
    notRunning?: true;
    events: TraceEvent[];
    categories: string[];
    durationMs: number;
  }> {
    if (!this.running) {
      return { notRunning: true, events: [], categories: [...this.categories], durationMs: 0 };
    }
    const durationMs = Date.now() - this.startedAt;
    await this.stopInternal(cdp);
    const evts = this.events;
    this.events = [];
    return { events: evts, categories: [...this.categories], durationMs };
  }

  /** Force-clean teardown for session close paths. Tolerates double calls. */
  async closeIfRunning(cdp: CDPSession): Promise<void> {
    if (!this.running) return;
    await this.stopInternal(cdp).catch(() => undefined);
    this.events = [];
  }

  /** Internal stop: send `Tracing.end`, wait for the `tracingComplete` flush,
   *  detach listeners. Guarantees `running=false` even on errors so the
   *  next start always works. */
  private async stopInternal(cdp: CDPSession): Promise<void> {
    this.completePromise = new Promise((res) => {
      this.completeResolve = res;
    });
    try {
      await cdp.send("Tracing.end").catch(() => undefined);
      // Bounded wait: the `tracingComplete` flush is normally near-instant
      // but a runaway target shouldn't deadlock us. 30s is generous.
      await Promise.race([
        this.completePromise,
        new Promise<void>((res) => setTimeout(res, 30_000)),
      ]);
    } finally {
      for (const off of this.listeners) {
        try {
          off();
        } catch {
          /* listener removal is best-effort */
        }
      }
      this.listeners = [];
      this.completePromise = null;
      this.completeResolve = null;
      this.running = false;
    }
  }
}
