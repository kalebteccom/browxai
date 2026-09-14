// The player's derived view over the event log (RFC 0007 P2). Pure: no DOM, no
// rrweb, no IO — everything here is a function of `ReplayEvent[]` and is unit
// tested in `src/replay/player.test.ts`.
//
// The forward-compatibility rule from `../schema.ts` is implemented here rather
// than asserted: an unrecognised `type` becomes an `unknown` marker and an
// entry in `unknownTypes`, and a recognised type whose payload is the wrong
// shape degrades to its defaults. Neither path throws, so a log written by a
// newer browxai still opens, still scrubs and still plays.

import type { ReplayEvent, ReplayManifest } from "../schema.js";

export const KNOWN_EVENT_TYPES: readonly string[] = [
  "dom/rrweb",
  "action/call",
  "action/result",
  "assert/result",
  "net/request",
  "net/response",
  "net/failed",
  "ws/open",
  "ws/frame",
  "ws/close",
  "console/message",
  "page/error",
  "page/lifecycle",
  "annotate/span",
  "framework/react-commit",
  "framework/redux-action",
  "framework/vue-event",
];

const KNOWN = new Set(KNOWN_EVENT_TYPES);

/** A gap this long with nothing in the log is skippable dead air. */
export const DEFAULT_IDLE_GAP_MS = 1500;

export type StepKind = "action" | "assert";

export interface Step {
  index: number;
  kind: StepKind;
  tool: string;
  /** Undefined when a call never got a result — a session that ended mid-tool. */
  ok?: boolean;
  error?: string;
  expected?: unknown;
  actual?: unknown;
  screenshot?: number;
  /** Playhead position showing the page as the tool found it. */
  before: number;
  /** Playhead position showing the page the tool left behind. */
  after: number;
  callIndex?: number;
  resultIndex?: number;
}

export type MarkerKind = "action" | "action-failed" | "assert-pass" | "assert-fail" | "unknown";

export interface Marker {
  t: number;
  kind: MarkerKind;
  label: string;
  /** Index into `TimelineModel.steps`, for the marker kinds that have a step. */
  step?: number;
}

export interface Span {
  label: string;
  from: number;
  to: number;
  note?: string;
  /** No `end` phase arrived: the span runs to the end of the log. */
  open: boolean;
}

export interface UnknownTypeSummary {
  type: string;
  count: number;
  firstT: number;
}

export interface IdleRange {
  from: number;
  to: number;
}

export interface TimelineModel {
  duration: number;
  steps: Step[];
  markers: Marker[];
  spans: Span[];
  unknownTypes: UnknownTypeSummary[];
  idle: IdleRange[];
  counts: Record<string, number>;
  domEventCount: number;
  malformedCount: number;
}

export interface BuildTimelineOptions {
  idleGapMs?: number;
  /** Lines the artifact reader could not parse, surfaced next to `truncated`. */
  malformed?: number;
}

function payloadOf(event: ReplayEvent): Record<string, unknown> {
  const p = event.payload;
  return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function at(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
}

/** Most-recent unmatched `action/call` for a tool. A tool that never got a
 *  result leaves its call on the stack and becomes a step with `ok` undefined,
 *  which is how a session killed mid-action reads on the timeline. */
class CallStack {
  private readonly byTool = new Map<string, number[]>();
  readonly open: { index: number; tool: string; t: number }[] = [];

  push(index: number, tool: string, t: number): void {
    this.open.push({ index, tool, t });
    const slots = this.byTool.get(tool);
    if (slots) slots.push(this.open.length - 1);
    else this.byTool.set(tool, [this.open.length - 1]);
  }

  take(tool: string): { index: number; t: number } | undefined {
    const slots = this.byTool.get(tool);
    const slot = slots?.pop();
    if (slot === undefined) return undefined;
    const entry = this.open[slot];
    if (!entry) return undefined;
    this.open.splice(slot, 1);
    for (const list of this.byTool.values()) {
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v !== undefined && v > slot) list[i] = v - 1;
      }
    }
    return { index: entry.index, t: entry.t };
  }
}

function resultStep(
  event: ReplayEvent,
  index: number,
  call: { index: number; t: number } | undefined,
  order: number,
): Step {
  const p = payloadOf(event);
  const kind: StepKind = event.type === "assert/result" ? "assert" : "action";
  const step: Step = {
    index: order,
    kind,
    tool: str(p.tool, "(unnamed)"),
    ok: typeof p.ok === "boolean" ? p.ok : undefined,
    before: call ? call.t : at(event.t),
    after: at(event.t),
    resultIndex: index,
  };
  if (call) step.callIndex = call.index;
  if (typeof p.error === "string") step.error = p.error;
  if (p.expected !== undefined) step.expected = p.expected;
  if (p.actual !== undefined) step.actual = p.actual;
  if (typeof p.screenshot === "number") step.screenshot = p.screenshot;
  return step;
}

function markerFor(step: Step): Marker {
  const kind: MarkerKind =
    step.kind === "assert"
      ? step.ok === true
        ? "assert-pass"
        : "assert-fail"
      : step.ok === false
        ? "action-failed"
        : "action";
  return { t: step.after, kind, label: step.tool, step: step.index };
}

function collectSpans(open: Map<string, Span>, closed: Span[], event: ReplayEvent): void {
  const p = payloadOf(event);
  const label = str(p.label, "");
  if (label === "") return;
  const t = at(event.t);
  const note = typeof p.note === "string" ? p.note : undefined;
  if (p.phase === "end") {
    const span = open.get(label);
    if (span) {
      // Already in `closed` — it is pushed when the span opens, so the strip
      // can draw a span that never closes. Closing it mutates that entry.
      span.to = t;
      span.open = false;
      open.delete(label);
      return;
    }
    closed.push({ label, from: t, to: t, open: false, ...(note ? { note } : {}) });
    return;
  }
  const span: Span = { label, from: t, to: t, open: true, ...(note ? { note } : {}) };
  open.set(label, span);
  closed.push(span);
}

function idleRanges(times: number[], duration: number, gap: number): IdleRange[] {
  const idle: IdleRange[] = [];
  let prev = 0;
  for (const t of times) {
    if (t - prev > gap) idle.push({ from: prev, to: t });
    prev = Math.max(prev, t);
  }
  if (duration - prev > gap) idle.push({ from: prev, to: duration });
  return idle;
}

/**
 * Fold the log into everything the shell renders. One pass, so a 500k-event log
 * costs one traversal and no per-panel re-scan.
 */
export function buildTimeline(
  events: readonly ReplayEvent[],
  opts: BuildTimelineOptions = {},
): TimelineModel {
  const gap = opts.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const steps: Step[] = [];
  const markers: Marker[] = [];
  const spans: Span[] = [];
  const openSpans = new Map<string, Span>();
  const unknown = new Map<string, UnknownTypeSummary>();
  const counts: Record<string, number> = {};
  const calls = new CallStack();
  const times: number[] = [];
  let duration = 0;
  let domEventCount = 0;

  events.forEach((event, index) => {
    const t = at(event.t);
    duration = Math.max(duration, t);
    times.push(t);
    counts[event.type] = (counts[event.type] ?? 0) + 1;

    if (event.type === "dom/rrweb") domEventCount++;
    else if (event.type === "action/call") calls.push(index, str(payloadOf(event).tool, ""), t);
    else if (event.type === "action/result" || event.type === "assert/result") {
      const step = resultStep(
        event,
        index,
        calls.take(str(payloadOf(event).tool, "")),
        steps.length,
      );
      steps.push(step);
      markers.push(markerFor(step));
    } else if (event.type === "annotate/span") collectSpans(openSpans, spans, event);
    else if (!KNOWN.has(event.type)) {
      const seen = unknown.get(event.type);
      if (seen) seen.count++;
      else unknown.set(event.type, { type: event.type, count: 1, firstT: t });
      markers.push({ t, kind: "unknown", label: event.type });
    }
  });

  for (const span of openSpans.values()) span.to = duration;
  times.sort((a, b) => a - b);

  return {
    duration,
    steps,
    markers,
    spans,
    unknownTypes: [...unknown.values()].sort((a, b) => a.firstT - b.firstT),
    idle: idleRanges(times, duration, gap),
    counts,
    domEventCount,
    malformedCount: opts.malformed ?? 0,
  };
}

/** The first failed assertion, or failing that the first failed action. The
 *  assertion wins even when an action failed earlier: an assertion is the
 *  reviewer's acceptance criterion, an action failure is often a retry. */
export function findFirstFailure(model: TimelineModel): Step | undefined {
  return (
    model.steps.find((s) => s.kind === "assert" && s.ok === false) ??
    model.steps.find((s) => s.ok === false)
  );
}

/** Index of the step the playhead is inside, or -1 before the first step. */
export function stepIndexAt(model: TimelineModel, t: number): number {
  let found = -1;
  for (const step of model.steps) {
    if (step.before <= t) found = step.index;
    else break;
  }
  return found;
}

/** True when `t` falls in dead air, so the scrubber can jump it. */
export function idleAt(model: TimelineModel, t: number): IdleRange | undefined {
  return model.idle.find((r) => t >= r.from && t < r.to);
}

export interface ReplayHealth {
  truncated?: ReplayManifest["truncated"];
  malformed: number;
  unknownTypes: UnknownTypeSummary[];
  digestVerified: boolean | undefined;
}

/** Everything the player has to say out loud. Truncation is the load-bearing
 *  one: a silently short replay is worse than a refused one. */
export function healthOf(
  manifest: ReplayManifest,
  model: TimelineModel,
  digestVerified: boolean | undefined,
): ReplayHealth {
  return {
    ...(manifest.truncated ? { truncated: manifest.truncated } : {}),
    malformed: model.malformedCount,
    unknownTypes: model.unknownTypes,
    digestVerified,
  };
}
