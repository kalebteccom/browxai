/// <reference lib="dom" />
// The console panel (RFC 0007 P3). `console/message` and `page/error` merged on
// one clock, filterable by level, with errors distinguishable at a glance.
//
// The merge is the point. An uncaught exception and the `console.error` the app
// logged about it are the same story to a reviewer, and they arrive on two event
// types; splitting them across two lists would make the reader reconstruct the
// order by hand. A page error keeps `source: "page"` so it still reads as the
// harder signal it is.
//
// A text filter narrows the rows on top of the level filter, and a selected row
// opens a details pane with the whole message and, for a page error, its stack.
// Selecting a row also seeks, through the host's delegated `data-t` listener.

import type { ReplayEvent } from "../../schema.js";
import { rawPayload, strField, timeOf, upToIndex, type EventSource } from "./event-index.js";
import { clearDetail, detailPane, renderDetail, type DetailSection } from "./panel-detail.js";
import type { PanelApi, PanelDef } from "./panel-host.js";
import {
  cell,
  displayText,
  el,
  emptyState,
  formatMs,
  headRow,
  matchesText,
  replaceKeepingFocus,
  row,
  setCurrent,
  setSelected,
  textFilter,
} from "./panel-ui.js";

export const CONSOLE_EVENT_TYPES = ["console/message", "page/error"] as const;

export const CONSOLE_EMPTY = "No console output or page errors in this artifact.";
export const CONSOLE_NONE_YET = "Nothing had been logged by this point on the timeline.";
export const CONSOLE_FILTERED =
  "Nothing matches the filters yet. Lower the level or clear the text.";

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
  /** Identity inside this panel: the row's position once sorted. */
  key: string;
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
    key: "",
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
    key: "",
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
  rows.forEach((entry, i) => {
    entry.key = String(i);
  });
  return rows;
}

/** The label a row shows in its level cell. */
export function levelLabel(entry: ConsoleRow): string {
  return entry.source === "page" ? "page error" : (entry.rawType ?? entry.level);
}

/**
 * The newest `limit` messages at or before `t` that pass the level filter and
 * the text filter. The text matches the message and the level label a row shows.
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
  text = "",
): { rows: ConsoleRow[]; more: boolean; total: number } {
  const floor = LEVEL_SEVERITY[minLevel];
  const total = upToIndex(rows, t, (r) => r.t);
  const picked: ConsoleRow[] = [];
  let i = total - 1;
  for (; i >= 0 && picked.length < limit; i--) {
    const entry = rows[i]!;
    if (
      LEVEL_SEVERITY[entry.level] >= floor &&
      matchesText(text, [entry.text, levelLabel(entry)])
    ) {
      picked.push(entry);
    }
  }
  picked.reverse();
  return { rows: picked, more: i >= 0, total };
}

/**
 * The details of one message, as sections. Pure: it reads the row and nothing
 * else. The message is the full text the row cuts short, and a page error also
 * carries its stack.
 */
export function consoleDetail(entry: ConsoleRow): DetailSection[] {
  const sections: DetailSection[] = [
    {
      id: "general",
      title: "General",
      fields: [
        { label: "Level", value: levelLabel(entry) },
        { label: "Source", value: entry.source === "page" ? "Page error" : "Console API" },
        { label: "Time", value: entry.t, text: `${entry.t} ms` },
      ],
    },
    { id: "message", title: "Message", text: entry.text, empty: "No message text recorded." },
  ];
  if (entry.source === "page") {
    sections.push({
      id: "stack",
      title: "Stack",
      text: entry.stack,
      empty: "No stack trace recorded.",
    });
  }
  return sections;
}

function rowNode(entry: ConsoleRow, selected: boolean, current: boolean): HTMLElement {
  const node = row(entry.t, "prow-console", [
    el("span", "pcell pcell-t", formatMs(entry.t)),
    el("span", "pcell pcell-level", levelLabel(entry)),
    cell(entry.text, "pcell-text"),
  ]);
  node.dataset.level = entry.level;
  node.dataset.source = entry.source;
  node.dataset.key = entry.key;
  if (entry.stack !== undefined) node.title = entry.stack;
  setSelected(node, selected);
  setCurrent(node, current);
  return node;
}

interface Ui {
  rows: readonly ConsoleRow[];
  level: ConsoleLevel;
  text: string;
  selected: string | undefined;
  /** The key last scrolled to, so playback scrolls when the current row
   *  changes and a redraw at the same place leaves the reviewer's scroll alone. */
  scrolledTo: string | undefined;
  table: HTMLElement;
  detail: HTMLElement;
  status: HTMLElement;
}

function filtered(ui: Ui): boolean {
  return ui.level !== "debug" || ui.text.trim() !== "";
}

function drawTable(ui: Ui, t: number): void {
  const resolved = resolveConsole(ui.rows, t, ui.level, MAX_ROWS, ui.text);
  const count = `${resolved.total.toLocaleString()} ${resolved.total === 1 ? "message" : "messages"}`;
  ui.status.textContent = filtered(ui)
    ? `${resolved.rows.length.toLocaleString()} of ${count} shown`
    : count;
  ui.table.dataset.rowCount = String(resolved.rows.length);
  if (resolved.rows.length === 0) {
    const empty = resolved.total === 0 ? CONSOLE_NONE_YET : CONSOLE_FILTERED;
    ui.table.replaceChildren(emptyState(empty));
    ui.scrolledTo = undefined;
    return;
  }
  const currentKey = resolved.rows[resolved.rows.length - 1]?.key;
  const nodes: HTMLElement[] = [headRow("prow-console", ["Time", "Level", "Message"])];
  if (resolved.more) nodes.push(el("div", "panel-note", "Earlier messages not shown."));
  for (const entry of resolved.rows) {
    nodes.push(rowNode(entry, entry.key === ui.selected, entry.key === currentKey));
  }
  replaceKeepingFocus(ui.table, nodes);
  if (currentKey !== ui.scrolledTo) {
    ui.scrolledTo = currentKey;
    ui.table.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }
}

function drawDetail(ui: Ui): void {
  const entry = ui.selected === undefined ? undefined : ui.rows[Number(ui.selected)];
  if (entry === undefined) {
    clearDetail(ui.detail);
    return;
  }
  renderDetail(
    ui.detail,
    `${levelLabel(entry)} at ${formatMs(entry.t)}: ${displayText(entry.text, 80)}`,
    consoleDetail(entry),
  );
}

function selectRow(ui: Ui, key: string): void {
  ui.selected = key;
  for (const node of Array.from(ui.table.querySelectorAll<HTMLElement>(".prow[data-key]"))) {
    setSelected(node, node.dataset.key === key);
  }
  drawDetail(ui);
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
      if (rows.length === 0) {
        container.replaceChildren(emptyState(CONSOLE_EMPTY));
        return;
      }
      const select = filterSelect();
      const text = textFilter("console-filter", "Filter");
      text.input.placeholder = "Message or level";
      const levelLabelNode = el("label", "control", "Level ");
      levelLabelNode.append(select);
      const status = el("span", "panel-status");
      const toolbar = el("div", "panel-toolbar");
      toolbar.append(text.label, levelLabelNode, status);

      const ui: Ui = {
        rows,
        level: "debug",
        text: "",
        selected: undefined,
        scrolledTo: undefined,
        table: el("div", "panel-table"),
        detail: detailPane("Message details"),
        status,
      };
      const split = el("div", "panel-split");
      split.append(ui.detail, ui.table);
      container.replaceChildren(toolbar, split);

      const draw = (): void => drawTable(ui, api.playhead());
      const refilter = (): void => {
        ui.level = select.value as ConsoleLevel;
        ui.text = text.input.value;
        draw();
      };
      select.addEventListener("change", refilter);
      text.input.addEventListener("input", refilter);
      ui.table.addEventListener("click", (ev) => {
        const node = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".prow[data-key]");
        if (node?.dataset.key !== undefined) selectRow(ui, node.dataset.key);
      });
      api.onSeek(draw);
      draw();
    },
  };
}
