/// <reference lib="dom" />
// The coverage view (RFC 0007 P3). `annotate/span` events grouped by `label`,
// which is how a reviewer answers the objection the whole replay exists to
// answer: the agent chose what to explore, so which of the paths I asked for did
// it actually exercise?
//
// An UNCLOSED span is the load-bearing case. It means the agent entered the
// path and never came back out — a crash, a timeout, a session cut short — and
// it is exactly the case a summary that only counted closed spans would hide.
// `../model.ts` already tracks it on `Span.open`; this panel renders it as its
// own state, with the word "unclosed" on the row.
//
// The playhead rule is deliberately weaker here than on the other three panels.
// A span that starts later in the session is still coverage, and hiding it until
// the playhead reaches it would answer the reviewer's question wrong. So every
// label is always listed, and the playhead colours the state instead: done,
// active right now, or still ahead.

import type { ReplayEvent } from "../../schema.js";
import { buildSpans, type Span } from "../model.js";
import {
  fromIndex,
  rawPayload,
  strField,
  timeOf,
  upToIndex,
  type EventIndex,
} from "./event-index.js";
import type { PanelApi, PanelDef } from "./panel-host.js";
import { badge, el, emptyState, formatMs, headRow, row } from "./panel-ui.js";

export const COVERAGE_EVENT_TYPES = ["annotate/span", "action/result", "assert/result"] as const;

export const COVERAGE_EMPTY =
  "No coverage spans in this artifact. record_annotate with a label marks the paths a reviewer asked for.";

const MAX_STEPS_PER_LABEL = 60;

export type CoverageState = "done" | "active" | "ahead";

export interface CoverageStep {
  t: number;
  tool: string;
  kind: "action" | "assert";
  ok?: boolean;
}

export interface CoverageGroup {
  label: string;
  spans: Span[];
  from: number;
  to: number;
  /** At least one span under this label never closed. */
  unclosed: boolean;
  note?: string;
  steps: CoverageStep[];
  failures: number;
}

export interface CoverageGroupView extends CoverageGroup {
  state: CoverageState;
  /** Steps inside the span that had already run at the playhead. */
  stepsSoFar: number;
}

function stepOf(event: ReplayEvent, kind: "action" | "assert"): CoverageStep {
  const ok = rawPayload(event).ok;
  const step: CoverageStep = { t: timeOf(event), tool: strField(event, "tool", "(unnamed)"), kind };
  if (typeof ok === "boolean") step.ok = ok;
  return step;
}

function allSteps(index: EventIndex): CoverageStep[] {
  const steps = [
    ...index.byType("action/result").map((e) => stepOf(e, "action")),
    ...index.byType("assert/result").map((e) => stepOf(e, "assert")),
  ];
  steps.sort((a, b) => a.t - b.t);
  return steps;
}

/** Steps whose result landed inside the span. `before` is not consulted on
 *  purpose: a tool that was already running when the span opened was not run
 *  *for* that acceptance criterion. */
function stepsIn(steps: readonly CoverageStep[], spans: readonly Span[]): CoverageStep[] {
  const picked: CoverageStep[] = [];
  for (const span of spans) {
    const start = fromIndex(steps, span.from, (s) => s.t);
    const end = upToIndex(steps, span.to, (s) => s.t);
    for (let i = start; i < end; i++) picked.push(steps[i]!);
  }
  return picked;
}

function groupOf(label: string, spans: Span[], steps: readonly CoverageStep[]): CoverageGroup {
  const inside = stepsIn(steps, spans);
  const note = spans.find((s) => s.note !== undefined)?.note;
  return {
    label,
    spans,
    from: Math.min(...spans.map((s) => s.from)),
    to: Math.max(...spans.map((s) => s.to)),
    unclosed: spans.some((s) => s.open),
    ...(note === undefined ? {} : { note }),
    steps: inside,
    failures: inside.filter((s) => s.ok === false).length,
  };
}

/** Group every span by label. Runs once, at mount. */
export function buildCoverage(index: EventIndex): CoverageGroup[] {
  const spans = buildSpans(index.byType("annotate/span"), index.duration);
  const steps = allSteps(index);
  const byLabel = new Map<string, Span[]>();
  for (const span of spans) {
    const list = byLabel.get(span.label);
    if (list) list.push(span);
    else byLabel.set(span.label, [span]);
  }
  return [...byLabel.entries()]
    .map(([label, group]) => groupOf(label, group, steps))
    .sort((a, b) => a.from - b.from);
}

export function resolveCoverage(groups: readonly CoverageGroup[], t: number): CoverageGroupView[] {
  return groups.map((group) => {
    const active = group.spans.some((s) => s.from <= t && t < s.to);
    const state: CoverageState = active ? "active" : group.from > t ? "ahead" : "done";
    return { ...group, state, stepsSoFar: upToIndex(group.steps, t, (s) => s.t) };
  });
}

function pct(value: number, duration: number): number {
  return duration <= 0 ? 0 : Math.min(100, Math.max(0, (value / duration) * 100));
}

function spanBar(view: CoverageGroupView, duration: number): HTMLElement {
  const bar = el("span", "pcell cov-bar");
  for (const span of view.spans) {
    const seg = el("span", "cov-seg");
    seg.dataset.open = String(span.open);
    seg.style.left = `${pct(span.from, duration)}%`;
    seg.style.width = `${Math.max(0.6, pct(span.to - span.from, duration))}%`;
    seg.title = `${formatMs(span.from)} → ${span.open ? "unclosed" : formatMs(span.to)}`;
    bar.append(seg);
  }
  return bar;
}

function verdict(view: CoverageGroupView): HTMLElement {
  if (view.unclosed) return badge("unclosed", "unclosed");
  if (view.failures > 0) return badge(`${view.failures} failed`, "fail");
  return badge(view.steps.length === 0 ? "no steps" : "closed", "ok");
}

function headerNode(view: CoverageGroupView, duration: number): HTMLElement {
  const node = row(view.from, "prow-cov-head", [
    el("span", "pcell pcell-label", view.label),
    spanBar(view, duration),
    el("span", "pcell pcell-steps", `${view.stepsSoFar}/${view.steps.length} steps`),
    el("span", "pcell pcell-state", view.state),
  ]);
  node.dataset.state = view.state;
  node.dataset.label = view.label;
  node.dataset.unclosed = String(view.unclosed);
  node.append(verdict(view));
  if (view.note !== undefined) node.title = view.note;
  return node;
}

function stepNode(step: CoverageStep, t: number): HTMLElement {
  const node = row(step.t, "prow-cov-step", [
    el("span", "pcell pcell-t", formatMs(step.t)),
    el("span", "pcell pcell-tool", step.tool),
    el("span", "pcell pcell-verdict", step.ok === undefined ? "—" : step.ok ? "ok" : "failed"),
  ]);
  node.dataset.ok = step.ok === undefined ? "unknown" : String(step.ok);
  node.dataset.kind = step.kind;
  // Past the playhead, so it is coverage the reviewer has not watched yet.
  if (step.t > t) node.dataset.future = "true";
  return node;
}

function groupNode(view: CoverageGroupView, duration: number, t: number): HTMLElement {
  const block = el("div", "cov-group");
  block.dataset.label = view.label;
  block.dataset.state = view.state;
  block.dataset.unclosed = String(view.unclosed);
  block.append(headerNode(view, duration));
  if (view.steps.length === 0) {
    block.append(el("div", "panel-note", "No steps ran inside this span."));
    return block;
  }
  for (const step of view.steps.slice(0, MAX_STEPS_PER_LABEL)) block.append(stepNode(step, t));
  if (view.steps.length > MAX_STEPS_PER_LABEL) {
    block.append(
      el("div", "panel-note", `${view.steps.length - MAX_STEPS_PER_LABEL} more steps not shown.`),
    );
  }
  return block;
}

function render(
  container: HTMLElement,
  groups: readonly CoverageGroup[],
  duration: number,
  t: number,
): void {
  if (groups.length === 0) {
    container.replaceChildren(emptyState(COVERAGE_EMPTY));
    return;
  }
  const nodes: HTMLElement[] = [headRow("prow-cov-head", ["Label", "Span", "Steps", "State"])];
  for (const view of resolveCoverage(groups, t)) nodes.push(groupNode(view, duration, t));
  container.replaceChildren(...nodes);
  container.dataset.rowCount = String(groups.length);
}

export function coveragePanel(): PanelDef {
  return {
    id: "coverage",
    title: "Coverage",
    eventTypes: [...COVERAGE_EVENT_TYPES],
    mount(container: HTMLElement, api: PanelApi) {
      const groups = buildCoverage(api.index);
      const duration = api.index.duration;
      const table = el("div", "panel-table");
      container.replaceChildren(table);
      api.onSeek((t) => render(table, groups, duration, t));
      render(table, groups, duration, api.playhead());
    },
  };
}
