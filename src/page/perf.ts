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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

/** Default trace categories — covers the cases DevTools' Performance panel
 *  uses for its core insights (frames, paint, layout, long tasks, user
 *  timing, loading). Smaller than the everything-on default to keep traces
 *  manageable. */
export const DEFAULT_TRACE_CATEGORIES = [
  "devtools.timeline",
  "loading",
  "blink.user_timing",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "latencyInfo",
];

/** Trace event row, as emitted by chromium tracing. We only care about a few
 *  fields; everything else passes through. */
export interface TraceEvent {
  name?: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  args?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Insights summary — small, structured, agent-friendly. */
export interface PerfInsights {
  /** Long tasks (≥50 ms blocking the main thread). DevTools' surface metric
   *  for "main thread was busy here". Sorted longest-first. */
  longTasks: Array<{ startMs: number; durationMs: number }>;
  /** Cumulative + per-shift LayoutShift entries. CLS-relevant. */
  layoutShifts: Array<{ startMs: number; score: number; hadRecentInput?: boolean }>;
  /** Resources that blocked the renderer (CSS / sync JS in the critical
   *  rendering path). Sorted by duration descending. */
  renderBlocking: Array<{ url: string; durationMs: number; type?: string }>;
  /** Largest-Contentful-Paint candidates — every `largestContentfulPaint::Candidate`
   *  event the trace recorded. The final candidate (latest `startMs`) is the
   *  effective LCP. */
  lcpCandidates: Array<{ startMs: number; size?: number; url?: string; nodeName?: string }>;
  /** Navigation timing milestones, if a navigationStart is present. */
  navigation?: {
    navigationStartMs: number;
    firstPaintMs?: number;
    firstContentfulPaintMs?: number;
    domContentLoadedMs?: number;
    loadEventMs?: number;
  };
  /** Aggregate counts — useful as a one-glance overview. */
  totals: {
    events: number;
    longTaskCount: number;
    layoutShiftCount: number;
    layoutShiftScoreSum: number;
    renderBlockingCount: number;
  };
  /** Non-fatal extraction warnings (unknown event shapes, etc.). */
  warnings?: string[];
}

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
  isRunning(): boolean { return this.running; }

  /** Start tracing on `cdp`. If a trace is already running, stops it cleanly
   *  first (events discarded) — guarantees the caller never gets stuck in a
   *  "tracing already started" CDP error from a stale start. */
  async start(cdp: CDPSession, opts: { categories?: string[] } = {}): Promise<{ categories: string[]; restarted: boolean }> {
    let restarted = false;
    if (this.running) {
      restarted = true;
      // Clean restart: stop the in-flight trace; throw away its events.
      await this.stopInternal(cdp).catch(() => undefined);
    }
    const categories = opts.categories && opts.categories.length > 0
      ? opts.categories
      : DEFAULT_TRACE_CATEGORIES;
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
  async stop(cdp: CDPSession): Promise<{ notRunning?: true; events: TraceEvent[]; categories: string[]; durationMs: number }> {
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
    this.completePromise = new Promise((res) => { this.completeResolve = res; });
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
        try { off(); } catch { /* listener removal is best-effort */ }
      }
      this.listeners = [];
      this.completePromise = null;
      this.completeResolve = null;
      this.running = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace path helper. Mirrors `resolveWorkspacePath` in session/storage.ts
// but kept local so this module doesn't reach across page → session.

export function resolvePerfTracePath(workspaceRoot: string, p: string, tool: string): string {
  const resolved = resolve(workspaceRoot, p);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(
      `${tool}: \`path\` must resolve inside $BROWX_WORKSPACE — got "${p}".`,
    );
  }
  return resolved;
}

/** Default trace filename under `<workspace>/perf-traces/<sessionId>-<ts>.json`. */
export function defaultTracePath(workspaceRoot: string, sessionId: string): string {
  // sanitize the session id for the filename — only safe chars survive.
  const safe = (sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(workspaceRoot, "perf-traces", `${safe}-${ts}.json`);
}

/** Write a trace event array as a chrome-tracing-compatible JSON file. The
 *  format the chromium ecosystem expects is `{ traceEvents: [...] }`; we
 *  also include `metadata` so a roundtrip through tracingControl tools is
 *  cleanly identifiable. */
export function writeTraceFile(
  workspaceRoot: string,
  filePath: string,
  events: TraceEvent[],
  meta: { categories: string[]; sessionId: string; durationMs: number },
  tool: string,
): { resolved: string; bytes: number } {
  // Path is workspace-rooted by construction via `resolvePerfTracePath`.
  const resolved = resolvePerfTracePath(workspaceRoot, filePath, tool);
  const parent = dirname(resolved);
  // ws.sub-style: ensure parent exists under workspace.root.
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  const payload = JSON.stringify({
    traceEvents: events,
    metadata: {
      source: "browxai",
      sessionId: meta.sessionId,
      categories: meta.categories,
      durationMs: meta.durationMs,
      eventCount: events.length,
      capturedAt: new Date().toISOString(),
    },
  });
  // ws.root-rooted path — see resolvePerfTracePath above for the guard.
  writeFileSync(resolved, payload, "utf8");
  return { resolved, bytes: Buffer.byteLength(payload, "utf8") };
}

/** Read a trace file and return the event array. */
export function readTraceFile(workspaceRoot: string, filePath: string, tool: string): { events: TraceEvent[]; metadata?: Record<string, unknown> } {
  const resolved = resolvePerfTracePath(workspaceRoot, filePath, tool);
  if (!existsSync(resolved)) {
    throw new Error(`${tool}: trace file not found at "${resolved}" — call perf_stop first`);
  }
  const raw = readFileSync(resolved, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${tool}: trace file "${resolved}" is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (Array.isArray(parsed)) {
    return { events: parsed as TraceEvent[] };
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { traceEvents?: unknown }).traceEvents)) {
    const obj = parsed as { traceEvents: TraceEvent[]; metadata?: Record<string, unknown> };
    return { events: obj.traceEvents, metadata: obj.metadata };
  }
  throw new Error(`${tool}: trace file "${resolved}" doesn't look like a chrome trace (missing traceEvents array)`);
}

// ---------------------------------------------------------------------------
// Minimal insights extractor over the trace event array.
//
// We deliberately avoid pulling in chrome-devtools-frontend's full Insights
// pipeline (it would dominate the dependency tree). The four extracts below
// cover the cases an agent diagnosing "why was that slow" actually asks:
//   - Long tasks: blocking work on the main thread
//   - Layout shifts: visual instability (CLS contributors)
//   - Render-blocking resources: critical-path CSS / sync JS
//   - LCP candidates: which element + when

const LONG_TASK_THRESHOLD_MS = 50;
const MAX_LIST_ENTRIES = 50;

/** Extract structured insights from a trace event array. Pure — exported for
 *  unit tests. */
export function extractInsights(events: TraceEvent[]): PerfInsights {
  const warnings: string[] = [];
  // chromium ts is microseconds; surface ms for the agent.
  const usToMs = (us: number | undefined): number => (typeof us === "number" ? us / 1000 : 0);

  // ---- long tasks
  const longTasks: PerfInsights["longTasks"] = [];
  // ---- layout shifts
  const layoutShifts: PerfInsights["layoutShifts"] = [];
  // ---- render-blocking resources: signalled by ResourceSendRequest events
  //      with `args.data.renderBlocking` ∈ {blocking, in_body_parser_blocking}
  //      plus a corresponding ResourceFinish event for duration.
  const sendStartByRequestId = new Map<string, { url: string; type?: string; tsMs: number; blocking: string }>();
  const renderBlocking: PerfInsights["renderBlocking"] = [];
  // ---- LCP candidates
  const lcpCandidates: PerfInsights["lcpCandidates"] = [];
  // ---- navigation milestones
  let navigationStartMs: number | undefined;
  let firstPaintMs: number | undefined;
  let firstContentfulPaintMs: number | undefined;
  let domContentLoadedMs: number | undefined;
  let loadEventMs: number | undefined;

  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const name = typeof e.name === "string" ? e.name : "";
    if (!name) continue;
    const ts = usToMs(e.ts);
    const dur = usToMs(e.dur);
    const args = (e.args ?? {}) as Record<string, unknown>;
    const data = (args.data ?? {}) as Record<string, unknown>;

    // Long tasks land as `RunTask` (or `RunMicrotasks`) on the renderer main
    // thread with dur ≥ 50ms. chromium's own LongTask v8 event is also
    // emitted with name "LongTask"; accept either spelling.
    if (name === "RunTask" || name === "LongTask") {
      if (dur >= LONG_TASK_THRESHOLD_MS) {
        longTasks.push({ startMs: ts, durationMs: dur });
      }
    }

    if (name === "LayoutShift") {
      const score = typeof data.score === "number" ? data.score
        : typeof (data.weighted_score_delta as unknown) === "number" ? (data.weighted_score_delta as number) : 0;
      const entry: PerfInsights["layoutShifts"][number] = { startMs: ts, score };
      if (data.had_recent_input === true) entry.hadRecentInput = true;
      layoutShifts.push(entry);
    }

    if (name === "ResourceSendRequest") {
      const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
      const url = typeof data.url === "string" ? data.url : "";
      const blocking = typeof data.renderBlocking === "string" ? data.renderBlocking : "";
      if (requestId && url && (blocking === "blocking" || blocking === "in_body_parser_blocking" || blocking === "non_blocking_dynamic")) {
        // We only treat the actively render-blocking ones as such. Track all
        // candidates so we can stitch durations on `ResourceFinish`.
        if (blocking === "blocking" || blocking === "in_body_parser_blocking") {
          sendStartByRequestId.set(requestId, {
            url, tsMs: ts, blocking,
            type: typeof data.resourceType === "string" ? (data.resourceType as string) : undefined,
          });
        }
      }
    }
    if (name === "ResourceFinish") {
      const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
      if (requestId && sendStartByRequestId.has(requestId)) {
        const start = sendStartByRequestId.get(requestId)!;
        renderBlocking.push({ url: start.url, type: start.type, durationMs: ts - start.tsMs });
        sendStartByRequestId.delete(requestId);
      }
    }

    if (name === "largestContentfulPaint::Candidate") {
      const entry: PerfInsights["lcpCandidates"][number] = { startMs: ts };
      if (typeof data.size === "number") entry.size = data.size as number;
      if (typeof data.DOMNodeId === "number") entry.nodeName = `#${String(data.DOMNodeId)}`;
      if (typeof data.nodeName === "string") entry.nodeName = data.nodeName as string;
      if (typeof data.url === "string") entry.url = data.url as string;
      lcpCandidates.push(entry);
    }

    // Navigation milestones (renderer-side).
    if (name === "navigationStart") {
      navigationStartMs = ts;
    } else if (name === "firstPaint") {
      firstPaintMs = ts;
    } else if (name === "firstContentfulPaint") {
      firstContentfulPaintMs = ts;
    } else if (name === "MarkDOMContent" || name === "domContentLoadedEventEnd") {
      domContentLoadedMs = ts;
    } else if (name === "MarkLoad" || name === "loadEventEnd") {
      loadEventMs = ts;
    }
  }

  // Sort + cap. Sorting by impact gives the agent the top contributors first.
  longTasks.sort((a, b) => b.durationMs - a.durationMs);
  renderBlocking.sort((a, b) => b.durationMs - a.durationMs);
  layoutShifts.sort((a, b) => b.score - a.score);
  // LCP candidates are best read newest-first (final candidate = effective LCP),
  // but agents tend to want chronological order — keep input order.

  const cap = <T,>(arr: T[]): T[] => arr.length > MAX_LIST_ENTRIES ? arr.slice(0, MAX_LIST_ENTRIES) : arr;

  const totals = {
    events: events.length,
    longTaskCount: longTasks.length,
    layoutShiftCount: layoutShifts.length,
    layoutShiftScoreSum: layoutShifts.reduce((s, l) => s + l.score, 0),
    renderBlockingCount: renderBlocking.length,
  };

  const insights: PerfInsights = {
    longTasks: cap(longTasks),
    layoutShifts: cap(layoutShifts),
    renderBlocking: cap(renderBlocking),
    lcpCandidates: cap(lcpCandidates),
    totals,
  };

  // Relativise navigation timing against navigationStart when we have one —
  // raw monotonic ts numbers are not interpretable; offsets are.
  if (navigationStartMs !== undefined) {
    insights.navigation = { navigationStartMs };
    if (firstPaintMs !== undefined) insights.navigation.firstPaintMs = firstPaintMs - navigationStartMs;
    if (firstContentfulPaintMs !== undefined) insights.navigation.firstContentfulPaintMs = firstContentfulPaintMs - navigationStartMs;
    if (domContentLoadedMs !== undefined) insights.navigation.domContentLoadedMs = domContentLoadedMs - navigationStartMs;
    if (loadEventMs !== undefined) insights.navigation.loadEventMs = loadEventMs - navigationStartMs;
  }

  if (warnings.length) insights.warnings = warnings;
  return insights;
}
