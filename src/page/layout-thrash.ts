// Layout-thrash trace — capability `read`. Focused CDP trace just for
// forced-synchronous-layout + layout-shift events, with origin-of-event
// stacks aggregated so the agent sees "this rAF loop is causing 200 forced
// layouts" at a glance instead of paging through a 100MB chromium trace.
//
// Pattern mirrors `src/page/perf.ts` (same `Tracing.dataCollected` →
// `Tracing.tracingComplete` flush flow) but the lifecycle is one-shot —
// caller doesn't manage state, this function arms + waits + parses + writes
// in one go.
//
// CDP `stackTrace` is populated on relevant trace events when DevTools is
// attached. We pick the topmost frame as `originatingStack` for the
// aggregation — that's the function name + url:line:col the agent acts on.

import type { CDPSession } from "playwright-core";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { TraceEvent } from "./perf.js";

/** Default categories for the focused trace — same set DevTools uses when
 *  it highlights "Forced Reflow" + "Layout Shift" lanes. */
export const LAYOUT_THRASH_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "blink.user_timing",
];

/** Per-origin aggregate: how many events fired from this call-stack + total
 *  cumulative time, plus a top-N representative origin string. */
export interface LayoutThrashOrigin {
  /** Topmost frame: `${functionName}@${url}:${lineNumber}:${columnNumber}` —
   *  or `"<anonymous>"` if no stack was attached. */
  originatingStack: string;
  count: number;
  totalDurationMs: number;
}

export interface LayoutThrashResult {
  forcedLayoutsCount: number;
  layoutShiftsCount: number;
  /** Sorted by count desc. Capped at 50. */
  eventsByOrigin: LayoutThrashOrigin[];
  /** Workspace-rooted path the trace was written to. */
  tracePath: string;
  durationMs: number;
}

export interface LayoutThrashOptions {
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 5_000;
const MAX_DURATION_MS = 30_000;
const MAX_ORIGINS = 50;

/** Workspace-rooted path helper — same shape as `resolvePerfTracePath`. */
function resolveLayoutThrashPath(workspaceRoot: string, p: string, tool: string): string {
  const resolved = resolve(workspaceRoot, p);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(`${tool}: \`path\` must resolve inside $BROWX_WORKSPACE — got "${p}".`);
  }
  return resolved;
}

/** Default trace filename under `<workspace>/perf/<sessionId>-layout-thrash-<ts>.json`. */
export function defaultLayoutThrashPath(workspaceRoot: string, sessionId: string): string {
  const safe = (sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(workspaceRoot, "perf", `${safe}-layout-thrash-${ts}.json`);
}

/** Run a focused layout-thrash trace. Records for `durationMs`, parses the
 *  result, writes the raw events to `<workspace>/perf/...`, returns the
 *  aggregated finding. */
export async function runLayoutThrashTrace(
  cdp: CDPSession,
  workspaceRoot: string,
  sessionId: string,
  opts: LayoutThrashOptions = {},
): Promise<LayoutThrashResult> {
  const durationMs = clampDuration(opts.durationMs);

  const events: TraceEvent[] = [];
  let complete: (() => void) | null = null;
  const onData = (e: { value: TraceEvent[] }) => {
    if (Array.isArray(e?.value)) {
      for (const ev of e.value) events.push(ev);
    }
  };
  const onComplete = () => {
    if (complete) complete();
  };
  cdp.on("Tracing.dataCollected", onData);
  cdp.on("Tracing.tracingComplete", onComplete);

  try {
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        recordMode: "recordContinuously",
        includedCategories: LAYOUT_THRASH_CATEGORIES,
      },
    });
    await new Promise<void>((res) => setTimeout(res, durationMs));
    const completionPromise = new Promise<void>((res) => {
      complete = res;
    });
    await cdp.send("Tracing.end").catch(() => undefined);
    await Promise.race([completionPromise, new Promise<void>((res) => setTimeout(res, 30_000))]);
  } finally {
    try {
      cdp.off("Tracing.dataCollected", onData);
    } catch {
      /* best-effort */
    }
    try {
      cdp.off("Tracing.tracingComplete", onComplete);
    } catch {
      /* best-effort */
    }
  }

  // Write the raw trace events file (workspace-rooted) so the agent can
  // re-open it in the DevTools Performance panel if desired.
  const tracePath = defaultLayoutThrashPath(workspaceRoot, sessionId);
  const resolved = resolveLayoutThrashPath(workspaceRoot, tracePath, "layout_thrash_trace");
  const parent = dirname(resolved);
  // ws.sub-style: ensure parent exists under workspace.root.
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  // ws.root-rooted path — see resolveLayoutThrashPath above for the guard.
  writeFileSync(
    resolved,
    JSON.stringify({
      traceEvents: events,
      metadata: {
        source: "browxai",
        sessionId,
        categories: LAYOUT_THRASH_CATEGORIES,
        durationMs,
        eventCount: events.length,
        capturedAt: new Date().toISOString(),
        kind: "layout-thrash",
      },
    }),
    "utf8",
  );

  const agg = aggregateLayoutThrash(events);
  return {
    forcedLayoutsCount: agg.forcedLayoutsCount,
    layoutShiftsCount: agg.layoutShiftsCount,
    eventsByOrigin: agg.eventsByOrigin,
    tracePath: resolved,
    durationMs,
  };
}

function clampDuration(d?: number): number {
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) return DEFAULT_DURATION_MS;
  if (d > MAX_DURATION_MS) return MAX_DURATION_MS;
  return Math.floor(d);
}

/** Aggregate trace events into the result shape. Pure — exported for unit
 *  tests against synthetic fixture event blobs. */
export function aggregateLayoutThrash(events: TraceEvent[]): {
  forcedLayoutsCount: number;
  layoutShiftsCount: number;
  eventsByOrigin: LayoutThrashOrigin[];
} {
  let forcedLayoutsCount = 0;
  let layoutShiftsCount = 0;
  const byOrigin = new Map<string, { count: number; totalDurationMs: number }>();
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const name = typeof e.name === "string" ? e.name : "";
    if (!name) continue;
    const isForced = name === "Layout" && hasForcedFlag(e);
    const isForcedAlt = name === "ForcedSyncLayout";
    const isShift = name === "LayoutShift";
    const isRecalc =
      name === "UpdateLayoutTree" || name === "Recalc Style" || name === "RecalculateStyles";
    if (isShift) layoutShiftsCount++;
    if (isForced || isForcedAlt) forcedLayoutsCount++;
    if (!isShift && !isForced && !isForcedAlt && !isRecalc) continue;
    const dur = typeof e.dur === "number" ? e.dur / 1000 : 0;
    const stack = extractOriginStack(e);
    const slot = byOrigin.get(stack);
    if (slot) {
      slot.count++;
      slot.totalDurationMs += dur;
    } else {
      byOrigin.set(stack, { count: 1, totalDurationMs: dur });
    }
  }
  const eventsByOrigin: LayoutThrashOrigin[] = [];
  for (const [originatingStack, { count, totalDurationMs }] of byOrigin) {
    eventsByOrigin.push({ originatingStack, count, totalDurationMs });
  }
  eventsByOrigin.sort((a, b) => b.count - a.count);
  return {
    forcedLayoutsCount,
    layoutShiftsCount,
    eventsByOrigin: eventsByOrigin.slice(0, MAX_ORIGINS),
  };
}

/** A `Layout` event is "forced sync" when chromium tags it with
 *  `args.beginData.frame` indicating a JS-driven layout pass. The reliable
 *  signal in the headless trace stream is the event itself — chromium emits
 *  `Layout` events on every forced/synchronous layout flush during the
 *  recording window. Initial page-load layouts also count; the aggregation
 *  by originating stack distinguishes one from the other.
 *
 *  Optimistic note: when DevTools is attached chromium DOES sometimes
 *  populate `args.data.stackTrace` on the event — we still prefer the
 *  flagged path when present, since it lets us split per-callsite. The
 *  bare-event fallback ensures the count surfaces even without stacks. */
function hasForcedFlag(e: TraceEvent): boolean {
  // `Layout` with a `beginData.frame` is a real layout flush — chromium
  // emits these on every synchronous layout it does during the recording
  // window. Treat any Layout event with begin/end data as a forced layout
  // for the count. The aggregation by originating stack handles
  // distinguishing per-origin contribution.
  const args = e.args as
    | { beginData?: Record<string, unknown>; data?: Record<string, unknown> }
    | undefined;
  if (!args) return false;
  if (args.beginData && typeof args.beginData === "object") return true;
  const data = (args.data ?? {}) as Record<string, unknown>;
  if (Array.isArray(data.stackTrace) && (data.stackTrace as unknown[]).length > 0) return true;
  return false;
}

/** Get the topmost stack frame as a stable origin string. Returns
 *  `"<anonymous>"` when no stack is available. */
function extractOriginStack(e: TraceEvent): string {
  const args = e.args as
    | { data?: Record<string, unknown>; beginData?: Record<string, unknown> }
    | undefined;
  if (!args) return "<anonymous>";
  const data = (args.data ?? args.beginData ?? {}) as Record<string, unknown>;
  const stack = data.stackTrace as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(stack) || stack.length === 0) return "<anonymous>";
  const top = stack[0] as Record<string, unknown> | undefined;
  if (!top) return "<anonymous>";
  const fn =
    typeof top.functionName === "string" && top.functionName ? top.functionName : "<anonymous>";
  const url = typeof top.url === "string" ? top.url : "";
  const line = typeof top.lineNumber === "number" ? top.lineNumber : 0;
  const col = typeof top.columnNumber === "number" ? top.columnNumber : 0;
  if (!url) return fn;
  return `${fn}@${url}:${line}:${col}`;
}
