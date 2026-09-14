/// <reference lib="dom" />
// Rendering. Every function here takes the model built in `./model.ts` and
// writes into the shell's fixed element ids, so the wiring in `./main.ts` never
// builds markup and the keystone can assert against stable `data-*` hooks
// rather than against text.

import type { ReplayManifest } from "../schema.js";
import type { Marker, ReplayHealth, Step, TimelineModel } from "./model.js";

/** Beyond this the strip is unreadable anyway, and one DOM node per marker on a
 *  log full of unknown events would be the player's own jank. */
const MAX_STRIP_MARKERS = 1500;

export interface Shell {
  body: HTMLElement;
  meta: HTMLElement;
  banners: HTMLElement;
  stage: HTMLElement;
  stageEmpty: HTMLElement;
  steps: HTMLElement;
  stepDetail: HTMLElement;
  jumpFailure: HTMLButtonElement;
  panelTabs: HTMLElement;
  panelBody: HTMLElement;
  strip: HTMLElement;
  playhead: HTMLElement;
  clock: HTMLElement;
  playPause: HTMLButtonElement;
  speed: HTMLSelectElement;
  skipIdle: HTMLInputElement;
  progress: HTMLElement;
  dropzone: HTMLElement;
  filePicker: HTMLInputElement;
}

function need<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`replay player: the shell is missing #${id}`);
  return el as unknown as T;
}

export function bindShell(): Shell {
  return {
    body: document.body,
    meta: need("meta"),
    banners: need("banners"),
    stage: need("stage"),
    stageEmpty: need("stage-empty"),
    steps: need("steps"),
    stepDetail: need("step-detail"),
    jumpFailure: need<HTMLButtonElement>("jump-failure"),
    panelTabs: need("panel-tabs"),
    panelBody: need("panel-body"),
    strip: need("strip"),
    playhead: need("playhead"),
    clock: need("clock"),
    playPause: need<HTMLButtonElement>("play-pause"),
    speed: need<HTMLSelectElement>("speed"),
    skipIdle: need<HTMLInputElement>("skip-idle"),
    progress: need("progress"),
    dropzone: need("dropzone"),
    filePicker: need<HTMLInputElement>("file-picker"),
  };
}

export function setState(shell: Shell, state: string): void {
  shell.body.dataset.playerState = state;
}

export function formatMs(ms: number): string {
  return `${(Math.max(0, Math.round(ms / 100)) / 10).toFixed(1)}s`;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderMeta(shell: Shell, manifest: ReplayManifest, model: TimelineModel): void {
  shell.meta.replaceChildren(
    el("span", "meta-item", `session ${manifest.sessionId}`),
    el("span", "meta-item", `tier ${manifest.tier}`),
    el("span", "meta-item", `schema v${manifest.schemaVersion}`),
    el("span", "meta-item", `browxai ${manifest.browxaiVersion}`),
    el("span", "meta-item", `${model.steps.length} steps`),
    el("span", "meta-item", `${model.domEventCount} DOM events`),
    el("span", "meta-item", formatMs(model.duration)),
  );
}

function banner(kind: string, title: string, detail: string): HTMLElement {
  const node = el("div", `banner banner-${kind}`);
  node.dataset.kind = kind;
  node.append(el("strong", "banner-title", title), el("span", "banner-detail", detail));
  return node;
}

/**
 * The load-bearing one is truncation. A silently short replay is worse than a
 * refused one, so it renders first, in the alarm style, and says which cap
 * tripped and how many events went missing.
 */
export function renderBanners(shell: Shell, health: ReplayHealth): void {
  const out: HTMLElement[] = [];
  const cut = health.truncated;
  if (cut) {
    out.push(
      banner(
        "truncated",
        "This replay is incomplete.",
        `Capture stopped at ${formatMs(cut.at)} (${cut.reason}) and ${cut.droppedEvents} events were dropped. Everything after that point is missing from the recording, not from the page.`,
      ),
    );
  }
  if (health.unknownTypes.length > 0) {
    const summary = health.unknownTypes.map((u) => `${u.type} x${u.count}`).join(", ");
    out.push(
      banner(
        "unknown",
        "Recorded by a newer browxai.",
        `${health.unknownTypes.length} event type(s) this player does not render are marked on the timeline: ${summary}.`,
      ),
    );
  }
  if (health.malformed > 0) {
    out.push(
      banner(
        "malformed",
        "Unreadable lines.",
        `${health.malformed} log lines were not valid JSON.`,
      ),
    );
  }
  if (health.digestVerified === false) {
    out.push(
      banner(
        "digest",
        "Integrity check failed.",
        "The event log does not hash to the digest in the manifest. Treat this replay as untrusted.",
      ),
    );
  } else if (health.digestVerified === undefined) {
    out.push(
      banner(
        "digest-skipped",
        "Integrity not checked.",
        "This log was too large to hash, or SubtleCrypto is unavailable here.",
      ),
    );
  }
  shell.banners.replaceChildren(...out);
}

function stepLabel(step: Step): string {
  if (step.ok === undefined) return "no result";
  if (step.kind === "assert") return step.ok ? "pass" : "fail";
  return step.ok ? "ok" : "failed";
}

export function renderSteps(shell: Shell, model: TimelineModel): void {
  const items = model.steps.map((step) => {
    const li = el("li", `step step-${step.kind}`);
    li.dataset.stepIndex = String(step.index);
    li.dataset.tool = step.tool;
    li.dataset.kind = step.kind;
    li.dataset.ok = step.ok === undefined ? "unknown" : String(step.ok);
    li.append(
      el("span", "step-n", String(step.index + 1)),
      el("span", "step-tool", step.tool),
      el("span", "step-verdict", stepLabel(step)),
      el("span", "step-t", formatMs(step.after)),
    );
    return li;
  });
  if (items.length === 0) items.push(el("li", "step step-empty", "No actions in this artifact."));
  shell.steps.replaceChildren(...items);
}

export function highlightStep(shell: Shell, index: number): void {
  for (const node of Array.from(shell.steps.querySelectorAll<HTMLElement>("li.step"))) {
    node.classList.toggle("is-current", node.dataset.stepIndex === String(index));
  }
}

function detailRow(label: string, value: string): HTMLElement {
  const row = el("div", "detail-row");
  row.append(el("span", "detail-label", label), el("span", "detail-value", value));
  return row;
}

function brief(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** Before/after for the selected step: the two timeline positions the scrubber
 *  jumps between, plus whatever the assertion compared. */
export function renderStepDetail(shell: Shell, step: Step | undefined): void {
  if (!step) {
    shell.stepDetail.replaceChildren(el("div", "detail-empty", "Select a step."));
    shell.stepDetail.dataset.stepIndex = "";
    return;
  }
  shell.stepDetail.dataset.stepIndex = String(step.index);
  const rows = [
    detailRow("tool", step.tool),
    detailRow("verdict", stepLabel(step)),
    detailRow("before", formatMs(step.before)),
    detailRow("after", formatMs(step.after)),
  ];
  if (step.error) rows.push(detailRow("error", brief(step.error)));
  if (step.expected !== undefined) rows.push(detailRow("expected", brief(step.expected)));
  if (step.actual !== undefined) rows.push(detailRow("actual", brief(step.actual)));
  shell.stepDetail.replaceChildren(...rows);
}

function pct(value: number, duration: number): number {
  return duration <= 0 ? 0 : Math.min(100, Math.max(0, (value / duration) * 100));
}

function markerNode(marker: Marker, duration: number): HTMLElement {
  const node = el("button", `mark mark-${marker.kind}`);
  node.dataset.kind = marker.kind;
  node.dataset.t = String(marker.t);
  if (marker.step !== undefined) node.dataset.stepIndex = String(marker.step);
  node.style.left = `${pct(marker.t, duration)}%`;
  node.title = `${marker.label} @ ${formatMs(marker.t)}`;
  node.setAttribute("aria-label", node.title);
  return node;
}

export function renderStrip(shell: Shell, model: TimelineModel): void {
  const nodes: HTMLElement[] = [];
  for (const range of model.idle) {
    const band = el("div", "idle-band");
    band.style.left = `${pct(range.from, model.duration)}%`;
    band.style.width = `${pct(range.to - range.from, model.duration)}%`;
    nodes.push(band);
  }
  for (const span of model.spans) {
    const band = el("div", "span-band");
    band.dataset.label = span.label;
    band.style.left = `${pct(span.from, model.duration)}%`;
    band.style.width = `${Math.max(0.4, pct(span.to - span.from, model.duration))}%`;
    band.title = span.note ? `${span.label} — ${span.note}` : span.label;
    nodes.push(band);
  }
  const markers = model.markers.slice(0, MAX_STRIP_MARKERS);
  for (const marker of markers) nodes.push(markerNode(marker, model.duration));
  shell.strip.replaceChildren(...nodes, shell.playhead);
  shell.strip.dataset.markerCount = String(markers.length);
}

export function renderPlayhead(shell: Shell, t: number, model: TimelineModel): void {
  shell.playhead.style.left = `${pct(t, model.duration)}%`;
  shell.clock.textContent = `${formatMs(t)} / ${formatMs(model.duration)}`;
  shell.clock.dataset.t = String(Math.round(t));
}

export function renderProgress(shell: Shell, text: string): void {
  shell.progress.textContent = text;
}

export function renderError(shell: Shell, message: string): void {
  setState(shell, "error");
  shell.banners.replaceChildren(banner("error", "Could not open this artifact.", message));
}
