// Performance insights — the pure, engine-blind read over a trace event array.
//
// This is the analytical half of perf tracing: given the flat `TraceEvent[]`
// that `perf-trace-io.ts` reads off disk (or that the CDP lifecycle in
// `perf.ts` buffered), distil a small, structured, agent-friendly summary. It
// touches no CDP, no filesystem, no Playwright — just data in, insights out —
// so it stays trivially unit-testable and its second reason-to-change (which
// signals we surface for "why was that slow") is isolated from the trace's
// transport and storage concerns.
//
// We deliberately avoid pulling in chrome-devtools-frontend's full Insights
// pipeline (it would dominate the dependency tree). The four extracts below
// cover the cases an agent diagnosing "why was that slow" actually asks:
//   - Long tasks: blocking work on the main thread
//   - Layout shifts: visual instability (CLS contributors)
//   - Render-blocking resources: critical-path CSS / sync JS
//   - LCP candidates: which element + when

import type { TraceEvent } from "./perf-trace-io.js";

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

const LONG_TASK_THRESHOLD_MS = 50;
const MAX_LIST_ENTRIES = 50;

/** Extract structured insights from a trace event array. Pure — exported for
 *  unit tests. */
/** chromium trace ts is microseconds; surface ms for the agent. */
function usToMs(us: number | undefined): number {
  return typeof us === "number" ? us / 1000 : 0;
}

/** Navigation milestones, captured raw (relativised against navigationStart at
 *  the end). */
interface NavMilestones {
  navigationStartMs?: number;
  firstPaintMs?: number;
  firstContentfulPaintMs?: number;
  domContentLoadedMs?: number;
  loadEventMs?: number;
}

/** The mutable accumulator the per-event handlers fill during the single pass. */
interface InsightsAcc {
  longTasks: PerfInsights["longTasks"];
  layoutShifts: PerfInsights["layoutShifts"];
  renderBlocking: PerfInsights["renderBlocking"];
  lcpCandidates: PerfInsights["lcpCandidates"];
  sendStartByRequestId: Map<string, { url: string; type?: string; tsMs: number; blocking: string }>;
  nav: NavMilestones;
}

function handleLayoutShift(acc: InsightsAcc, ts: number, data: Record<string, unknown>): void {
  const score =
    typeof data.score === "number"
      ? data.score
      : typeof data.weighted_score_delta === "number"
        ? data.weighted_score_delta
        : 0;
  const entry: PerfInsights["layoutShifts"][number] = { startMs: ts, score };
  if (data.had_recent_input === true) entry.hadRecentInput = true;
  acc.layoutShifts.push(entry);
}

/** Render-blocking resources are stitched: a `blocking`/`in_body_parser_blocking`
 *  `ResourceSendRequest` records the start; the matching `ResourceFinish` emits
 *  the duration. */
function handleResourceEvent(
  acc: InsightsAcc,
  name: string,
  ts: number,
  data: Record<string, unknown>,
): void {
  const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
  if (!requestId) return;
  if (name === "ResourceSendRequest") {
    const url = typeof data.url === "string" ? data.url : "";
    const blocking = typeof data.renderBlocking === "string" ? data.renderBlocking : "";
    if (url && (blocking === "blocking" || blocking === "in_body_parser_blocking")) {
      acc.sendStartByRequestId.set(requestId, {
        url,
        tsMs: ts,
        blocking,
        type: typeof data.resourceType === "string" ? data.resourceType : undefined,
      });
    }
  } else if (name === "ResourceFinish" && acc.sendStartByRequestId.has(requestId)) {
    const start = acc.sendStartByRequestId.get(requestId)!;
    acc.renderBlocking.push({ url: start.url, type: start.type, durationMs: ts - start.tsMs });
    acc.sendStartByRequestId.delete(requestId);
  }
}

function handleLcpCandidate(acc: InsightsAcc, ts: number, data: Record<string, unknown>): void {
  const entry: PerfInsights["lcpCandidates"][number] = { startMs: ts };
  if (typeof data.size === "number") entry.size = data.size;
  if (typeof data.DOMNodeId === "number") entry.nodeName = `#${String(data.DOMNodeId)}`;
  if (typeof data.nodeName === "string") entry.nodeName = data.nodeName;
  if (typeof data.url === "string") entry.url = data.url;
  acc.lcpCandidates.push(entry);
}

const NAV_MILESTONE_BY_NAME: Record<string, keyof NavMilestones> = {
  navigationStart: "navigationStartMs",
  firstPaint: "firstPaintMs",
  firstContentfulPaint: "firstContentfulPaintMs",
  MarkDOMContent: "domContentLoadedMs",
  domContentLoadedEventEnd: "domContentLoadedMs",
  MarkLoad: "loadEventMs",
  loadEventEnd: "loadEventMs",
};

/** Dispatch one trace event into the accumulator. */
function ingestEvent(acc: InsightsAcc, e: TraceEvent): void {
  if (!e || typeof e !== "object") return;
  const name = typeof e.name === "string" ? e.name : "";
  if (!name) return;
  const ts = usToMs(e.ts);
  const data = ((e.args ?? {}).data ?? {}) as Record<string, unknown>;
  // Long tasks: `RunTask` / `LongTask` on the main thread with dur ≥ threshold.
  if ((name === "RunTask" || name === "LongTask") && usToMs(e.dur) >= LONG_TASK_THRESHOLD_MS) {
    acc.longTasks.push({ startMs: ts, durationMs: usToMs(e.dur) });
  } else if (name === "LayoutShift") {
    handleLayoutShift(acc, ts, data);
  } else if (name === "ResourceSendRequest" || name === "ResourceFinish") {
    handleResourceEvent(acc, name, ts, data);
  } else if (name === "largestContentfulPaint::Candidate") {
    handleLcpCandidate(acc, ts, data);
  }
  const navKey = NAV_MILESTONE_BY_NAME[name];
  if (navKey) acc.nav[navKey] = ts;
}

/** Relativise navigation timing against navigationStart — raw monotonic ts
 *  numbers aren't interpretable; offsets are. */
function buildNavigation(nav: NavMilestones): PerfInsights["navigation"] | undefined {
  if (nav.navigationStartMs === undefined) return undefined;
  const start = nav.navigationStartMs;
  const out: NonNullable<PerfInsights["navigation"]> = { navigationStartMs: start };
  if (nav.firstPaintMs !== undefined) out.firstPaintMs = nav.firstPaintMs - start;
  if (nav.firstContentfulPaintMs !== undefined)
    out.firstContentfulPaintMs = nav.firstContentfulPaintMs - start;
  if (nav.domContentLoadedMs !== undefined) out.domContentLoadedMs = nav.domContentLoadedMs - start;
  if (nav.loadEventMs !== undefined) out.loadEventMs = nav.loadEventMs - start;
  return out;
}

export function extractInsights(events: TraceEvent[]): PerfInsights {
  const acc: InsightsAcc = {
    longTasks: [],
    layoutShifts: [],
    renderBlocking: [],
    lcpCandidates: [],
    sendStartByRequestId: new Map(),
    nav: {},
  };
  for (const e of events) ingestEvent(acc, e);

  // Sort by impact (top contributors first). LCP candidates stay in input order
  // (chronological) — the final candidate is the effective LCP.
  acc.longTasks.sort((a, b) => b.durationMs - a.durationMs);
  acc.renderBlocking.sort((a, b) => b.durationMs - a.durationMs);
  acc.layoutShifts.sort((a, b) => b.score - a.score);

  const cap = <T>(arr: T[]): T[] =>
    arr.length > MAX_LIST_ENTRIES ? arr.slice(0, MAX_LIST_ENTRIES) : arr;
  const insights: PerfInsights = {
    longTasks: cap(acc.longTasks),
    layoutShifts: cap(acc.layoutShifts),
    renderBlocking: cap(acc.renderBlocking),
    lcpCandidates: cap(acc.lcpCandidates),
    totals: {
      events: events.length,
      longTaskCount: acc.longTasks.length,
      layoutShiftCount: acc.layoutShifts.length,
      layoutShiftScoreSum: acc.layoutShifts.reduce((s, l) => s + l.score, 0),
      renderBlockingCount: acc.renderBlocking.length,
    },
  };
  const navigation = buildNavigation(acc.nav);
  if (navigation) insights.navigation = navigation;
  return insights;
}
