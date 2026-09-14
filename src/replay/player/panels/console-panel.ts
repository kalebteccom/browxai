/// <reference lib="dom" />
// The console panel (RFC 0007 P3). `console/message` and `page/error` merged on
// one clock, filterable by level, with errors distinguishable at a glance.
//
// The merge is the point. An uncaught exception and the `console.error` the app
// logged about it are the same story to a reviewer, and they arrive on two event
// types; splitting them across two lists would make the reader reconstruct the
// order by hand. A page error keeps `source: "page"` so it still reads as the
// harder signal it is.

import type { ReplayEvent } from "../../schema.js";
import { rawPayload, strField, timeOf, upToIndex, type EventSource } from "./event-index.js";
import type { PanelApi, PanelDef } from "./panel-host.js";
import { cell, el, emptyState, formatMs, headRow, row } from "./panel-ui.js";

export const CONSOLE_EVENT_TYPES = ["console/message", "page/error"] as const;

export const CONSOLE_EMPTY = "No console output or page errors in this artifact.";
export const CONSOLE_NONE_YET = "Nothing had been logged by this point on the timeline.";
export const CONSOLE_FILTERED = "Nothing at this level yet. Lower the filter to see more.";

const MAX_ROWS = 400;

export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";

/** Ordering for the level filter. `log` and `info` sit together on purpose:
 *  the two are the same thing to every engine that emits them. */
export const LEVEL_SEVERITY: Record<ConsoleLevel, number> = {
  debug: 0,
  log: 1,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_BY_CONSOLE_TYPE: Record<string, ConsoleLevel> = {
  log: "log",
  error: "error",
  assert: "error",
  warning: "warn",
  warn: "warn",
  info: "info",
  debug: "debug",
  trace: "debug",
  verbose: "debug",
};

export interface ConsoleRow {
  t: number;
  level: ConsoleLevel;
  source: "console" | "page";
  text: unknown;
  stack?: string;
  /** The raw `type` the page reported, kept when it is not one this build maps —
   *  a level it has never heard of reads as `log` and still says what it was. */
  rawType?: string;
}

export function levelOf(consoleType: string): ConsoleLevel {
  return LEVEL_BY_CONSOLE_TYPE[consoleType.toLowerCase()] ?? "log";
}

function messageRow(event: ReplayEvent): ConsoleRow {
  const type = strField(event, "type", "log");
  const level = levelOf(type);
  const built: ConsoleRow = {
    t: timeOf(event),
    level,
    source: "console",
    text: rawPayload(event).text,
  };
  if (LEVEL_BY_CONSOLE_TYPE[type.toLowerCase()] === undefined) built.rawType = type;
  return built;
}

function errorRow(event: ReplayEvent): ConsoleRow {
  const built: ConsoleRow = {
    t: timeOf(event),
    level: "error",
    source: "page",
    text: rawPayload(event).text,
  };
  const stack = strField(event, "stack", "");
  if (stack !== "") built.stack = stack;
  return built;
}

/** Both types on one clock, ordered. Runs once, at mount. */
export function buildConsoleRows(index: EventSource): ConsoleRow[] {
  const rows = [
    ...index.events("console/message").map(messageRow),
    ...index.events("page/error").map(errorRow),
  ];
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/**
 * The newest `limit` messages at or before `t` that pass the level filter.
 *
 * The walk runs BACKWARD from the playhead and stops once the window is full,
 * so a seek costs the size of the window rather than the size of the log. The
 * `more` flag says the walk stopped early, which is the honest thing to render
 * when the count of what was skipped was never computed.
 */
export function resolveConsole(
  rows: readonly ConsoleRow[],
  t: number,
  minLevel: ConsoleLevel = "debug",
  limit = MAX_ROWS,
): { rows: ConsoleRow[]; more: boolean; total: number } {
  const floor = LEVEL_SEVERITY[minLevel];
  const total = upToIndex(rows, t, (r) => r.t);
  const picked: ConsoleRow[] = [];
  let i = total - 1;
  for (; i >= 0 && picked.length < limit; i--) {
    const entry = rows[i]!;
    if (LEVEL_SEVERITY[entry.level] >= floor) picked.push(entry);
  }
  picked.reverse();
  return { rows: picked, more: i >= 0, total };
}

function rowNode(entry: ConsoleRow): HTMLElement {
  const label = entry.source === "page" ? "page error" : (entry.rawType ?? entry.level);
  const node = row(entry.t, "prow-console", [
    el("span", "pcell pcell-t", formatMs(entry.t)),
    el("span", "pcell pcell-level", label),
    cell(entry.text, "pcell-text"),
  ]);
  node.dataset.level = entry.level;
  node.dataset.source = entry.source;
  if (entry.stack !== undefined) node.title = entry.stack;
  return node;
}

function render(
  container: HTMLElement,
  rows: readonly ConsoleRow[],
  t: number,
  minLevel: ConsoleLevel,
): void {
  if (rows.length === 0) {
    container.replaceChildren(emptyState(CONSOLE_EMPTY));
    return;
  }
  const resolved = resolveConsole(rows, t, minLevel);
  if (resolved.rows.length === 0) {
    const empty = resolved.total === 0 ? CONSOLE_NONE_YET : CONSOLE_FILTERED;
    container.replaceChildren(emptyState(empty));
    return;
  }
  const nodes: HTMLElement[] = [headRow("prow-console", ["Time", "Level", "Message"])];
  if (resolved.more) nodes.push(el("div", "panel-note", "Earlier messages not shown."));
  for (const entry of resolved.rows) nodes.push(rowNode(entry));
  container.replaceChildren(...nodes);
  container.dataset.rowCount = String(resolved.rows.length);
}

const FILTER_OPTIONS: readonly [ConsoleLevel, string][] = [
  ["debug", "All levels"],
  ["info", "Info and above"],
  ["warn", "Warnings and errors"],
  ["error", "Errors only"],
];

function filterSelect(): HTMLSelectElement {
  const select = el("select", "panel-filter") as HTMLSelectElement;
  select.id = "console-level";
  for (const [value, label] of FILTER_OPTIONS) {
    const option = el("option", undefined, label) as HTMLOptionElement;
    option.value = value;
    select.append(option);
  }
  return select;
}

export function consolePanel(): PanelDef {
  return {
    id: "console",
    title: "Console",
    eventTypes: [...CONSOLE_EVENT_TYPES],
    mount(container: HTMLElement, api: PanelApi) {
      const rows = buildConsoleRows(api);
      const select = filterSelect();
      const toolbar = el("div", "panel-toolbar");
      const label = el("label", "control", "Level ");
      label.append(select);
      toolbar.append(label);
      const table = el("div", "panel-table");
      container.replaceChildren(toolbar, table);
      const draw = (): void => render(table, rows, api.playhead(), select.value as ConsoleLevel);
      select.addEventListener("change", draw);
      api.onSeek(draw);
      draw();
    },
  };
}
