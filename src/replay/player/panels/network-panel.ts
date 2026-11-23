/// <reference lib="dom" />
// The network panel (RFC 0007 P3). Requests correlated by `requestId` across
// `net/request` → `net/response` / `net/failed`, resolved against the playhead.
//
// The playhead rule is the reason this panel is not a table dump: at time `t` a
// reviewer must see what the page had seen by `t`. A request that has not been
// sent yet is absent, and one whose response had not landed yet is IN FLIGHT —
// not silently shown with the status it would eventually get. The correlation
// runs once when the panel mounts; a seek is a binary search over rows already
// ordered by their start.
//
// Two things sit on top of that. A filter (text over what a row shows, and a
// status class) narrows the rows, and a selected row opens a details pane with
// its masked request and response. Selecting a row also seeks, through the
// host's delegated `data-t` listener, so the pane and the page replay agree on
// where the reviewer is.

import { isRedacted } from "../../schema.js";
import type { CaptureTier, ReplayEvent } from "../../schema.js";
import {
  asObject,
  objField,
  rawPayload,
  strField,
  timeOf,
  upToIndex,
  windowUpTo,
  type EventSource,
} from "./event-index.js";
import {
  clearDetail,
  detailPane,
  renderDetail,
  type DetailField,
  type DetailSection,
} from "./panel-detail.js";
import type { PanelApi, PanelDef } from "./panel-host.js";
import {
  cell,
  displayText,
  el,
  EM_DASH,
  emptyState,
  formatBytes,
  formatMs,
  headRow,
  matchesText,
  overflowNote,
  replaceKeepingFocus,
  row,
  setCurrent,
  setSelected,
  textFilter,
} from "./panel-ui.js";

export const NETWORK_EVENT_TYPES = ["net/request", "net/response", "net/failed"] as const;

export const NETWORK_EMPTY =
  "No network events in this artifact. Capture at the replay tier or above records requests.";
export const NETWORK_NONE_YET = "No requests had been sent by this point on the timeline.";
export const NETWORK_FILTERED = "No request matches the filter by this point on the timeline.";
export const NETWORK_NOT_CAPTURED =
  "Not captured at this tier. Network traffic is recorded at the replay tier and above.";

/** Beyond this the panel is a wall, not a view. The window keeps the most
 *  recent rows before the playhead and says how many it left out. */
const MAX_ROWS = 300;

export type NetState = "pending" | "ok" | "error" | "failed";

export interface NetRow {
  /** Identity inside this panel: the row's position once sorted. A request id
   *  is not enough, because a redirect chain reuses one. */
  key: string;
  requestId: string;
  method: string;
  url: unknown;
  resourceType: string;
  startT: number;
  endT?: number;
  status?: number;
  /** `number`, the redaction marker when the size came from a header that was
   *  taken out, or undefined when the log never carried one. */
  size?: unknown;
  error?: string;
  /** The log carried a response or a failure whose request never appeared —
   *  a capture that started mid-flight, not a player bug. */
  orphan?: boolean;
  /** Carried through for the details pane. Each is exactly what the log holds,
   *  so a value that was masked at capture is still masked here. */
  requestHeaders?: Record<string, unknown>;
  postData?: unknown;
  responseHeaders?: Record<string, unknown>;
  mimeType?: string;
  /** Present only at the tier that records bodies. */
  body?: unknown;
}

export interface NetRowView extends NetRow {
  state: NetState;
  durationMs?: number;
}

function headerValue(headers: Record<string, unknown>, name: string): unknown {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** Size, in the order the log is likely to carry it. A redacted `content-length`
 *  returns the marker rather than falling through to the next source: "this was
 *  taken out" is the true answer, and the next source would answer a different
 *  question. */
function sizeOf(payload: Record<string, unknown>, headers: Record<string, unknown>): unknown {
  const encoded = payload.encodedDataLength;
  if (typeof encoded === "number") return encoded;
  const declared = headerValue(headers, "content-length");
  if (isRedacted(declared)) return declared;
  if (typeof declared === "string" && declared.trim() !== "" && Number.isFinite(Number(declared))) {
    return Number(declared);
  }
  const body = payload.body;
  if (isRedacted(body)) return body;
  if (typeof body === "string") return body.length;
  return undefined;
}

function requestRow(event: ReplayEvent): NetRow {
  const request = objField(event, "request");
  const built: NetRow = {
    key: "",
    requestId: strField(event, "requestId"),
    method: typeof request.method === "string" ? request.method : "GET",
    url: request.url,
    resourceType: strField(event, "type", ""),
    startT: timeOf(event),
  };
  const headers = asObject(request.headers);
  if (Object.keys(headers).length > 0) built.requestHeaders = headers;
  if (request.postData !== undefined) built.postData = request.postData;
  return built;
}

/**
 * Correlate the three network event types into one row per request. Runs once,
 * at mount.
 */
export function buildNetworkRows(index: EventSource): NetRow[] {
  const rows: NetRow[] = [];
  const byId = new Map<string, NetRow>();
  for (const event of index.events("net/request")) {
    const built = requestRow(event);
    rows.push(built);
    byId.set(built.requestId, built);
  }
  const orphan = (id: string, t: number, url: unknown, type: string): NetRow => {
    const made: NetRow = {
      key: "",
      requestId: id,
      method: "?",
      url,
      resourceType: type,
      startT: t,
      orphan: true,
    };
    rows.push(made);
    byId.set(id, made);
    return made;
  };
  for (const event of index.events("net/response")) {
    const id = strField(event, "requestId");
    const response = objField(event, "response");
    const target = byId.get(id) ?? orphan(id, timeOf(event), response.url, strField(event, "type"));
    target.endT = timeOf(event);
    if (typeof response.status === "number") target.status = response.status;
    if (target.resourceType === "") target.resourceType = strField(event, "type");
    target.size = sizeOf(rawPayload(event), asObject(response.headers));
    const headers = asObject(response.headers);
    if (Object.keys(headers).length > 0) target.responseHeaders = headers;
    if (typeof response.mimeType === "string") target.mimeType = response.mimeType;
    const body = rawPayload(event).body;
    if (body !== undefined) target.body = body;
  }
  for (const event of index.events("net/failed")) {
    const id = strField(event, "requestId");
    const target = byId.get(id) ?? orphan(id, timeOf(event), undefined, strField(event, "type"));
    target.endT = timeOf(event);
    target.error = strField(event, "errorText", rawPayload(event).canceled ? "canceled" : "failed");
  }
  rows.sort((a, b) => a.startT - b.startT);
  rows.forEach((net, i) => {
    net.key = String(i);
  });
  return rows;
}

function stateAt(net: NetRow, t: number): NetState {
  if (net.endT === undefined || net.endT > t) return "pending";
  if (net.error !== undefined) return "failed";
  return net.status !== undefined && net.status >= 400 ? "error" : "ok";
}

function viewAt(net: NetRow, t: number): NetRowView {
  const state = stateAt(net, t);
  const view: NetRowView = { ...net, state };
  if (state === "pending") {
    delete view.status;
    delete view.size;
    delete view.error;
  } else if (net.endT !== undefined) view.durationMs = Math.max(0, net.endT - net.startT);
  return view;
}

/** The status filter takes a row's state at the playhead, so "HTTP errors" never
 *  shows a request whose response had not landed yet. */
export type NetStatusFilter = "all" | NetState;

export interface NetFilter {
  /** Matched, case-insensitively, against the method, URL, status text and
   *  type a row shows. */
  text: string;
  state: NetStatusFilter;
}

export const NO_NET_FILTER: NetFilter = { text: "", state: "all" };

function isFiltered(filter: NetFilter): boolean {
  return filter.state !== "all" || filter.text.trim() !== "";
}

export function netViewMatches(view: NetRowView, filter: NetFilter): boolean {
  if (filter.state !== "all" && view.state !== filter.state) return false;
  return matchesText(filter.text, [view.method, view.url, statusText(view), view.resourceType]);
}

/** Rows as they stood at `t`: nothing that had not started, nothing resolved
 *  with an outcome that had not arrived. With a filter, the window is taken
 *  over the rows that match, so a filter reaches the whole log up to `t` and
 *  not only the newest rows. `matched` counts them before the window. */
export function resolveNetwork(
  rows: readonly NetRow[],
  t: number,
  limit = MAX_ROWS,
  filter: NetFilter = NO_NET_FILTER,
): { rows: NetRowView[]; hidden: number; total: number; matched: number } {
  if (!isFiltered(filter)) {
    const window = windowUpTo(rows, t, limit, (r) => r.startT);
    return {
      rows: window.rows.map((net) => viewAt(net, t)),
      hidden: window.hidden,
      total: window.total,
      matched: window.total,
    };
  }
  const total = upToIndex(rows, t, (r) => r.startT);
  const matched: NetRowView[] = [];
  for (let i = 0; i < total; i++) {
    const view = viewAt(rows[i]!, t);
    if (netViewMatches(view, filter)) matched.push(view);
  }
  const from = Math.max(0, matched.length - limit);
  return { rows: matched.slice(from), hidden: from, total, matched: matched.length };
}

export function statusText(view: NetRowView): string {
  if (view.state === "pending") return "in flight";
  if (view.state === "failed") return view.error ?? "failed";
  return view.status === undefined ? "—" : String(view.status);
}

// ---------- the details pane ----------

function headerFields(headers: Record<string, unknown> | undefined): DetailField[] {
  if (headers === undefined) return [];
  return Object.entries(headers)
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([label, value]) => ({ label, value }));
}

function outcomeText(net: NetRow): string {
  if (net.error !== undefined) return `failed: ${net.error}`;
  if (net.status !== undefined) return String(net.status);
  return net.endT === undefined ? "no response recorded" : EM_DASH;
}

/** What the body section says when the log holds no body. Below the tier that
 *  records bodies that is a fact about the tier, so the pane says so; at that
 *  tier it is a fact about this one response. */
export function bodyGap(tier: CaptureTier | undefined): string {
  return tier === "reexecutable"
    ? "No body was recorded for this response."
    : "Not captured at this tier. Response bodies are recorded at the reexecutable tier.";
}

/**
 * The details of one request, as sections. Pure: it reads the row and nothing
 * else. It shows the whole record, whatever the playhead reads, because a
 * reviewer who selects a request is asking about that request. The timing
 * fields say when it started and finished on the artifact clock.
 */
export function networkDetail(net: NetRow, tier?: CaptureTier): DetailSection[] {
  const finished = net.endT === undefined ? "not recorded" : `${net.endT} ms`;
  const duration =
    net.endT === undefined ? EM_DASH : `${Math.max(0, net.endT - net.startT).toLocaleString()} ms`;
  const general: DetailField[] = [
    { label: "URL", value: net.url },
    { label: "Method", value: net.method },
    { label: "Status", value: net.status, text: outcomeText(net) },
    { label: "Type", value: net.resourceType === "" ? undefined : net.resourceType },
    { label: "MIME type", value: net.mimeType },
    { label: "Size", value: net.size, text: formatBytes(net.size) },
    { label: "Started at", value: net.startT, text: `${net.startT} ms` },
    { label: "Finished at", value: net.endT, text: finished },
    { label: "Duration", value: net.endT, text: duration },
  ];
  const responseGap = net.endT === undefined ? "No response recorded." : undefined;
  return [
    { id: "general", title: "General", fields: general },
    {
      id: "request-headers",
      title: "Request headers",
      fields: headerFields(net.requestHeaders),
      empty: "No request headers recorded.",
    },
    {
      id: "request-body",
      title: "Request body",
      text: net.postData,
      empty: "No request body.",
    },
    {
      id: "response-headers",
      title: "Response headers",
      fields: headerFields(net.responseHeaders),
      empty: responseGap ?? "No response headers recorded.",
    },
    {
      id: "response-body",
      title: "Response body",
      text: net.body,
      empty: responseGap ?? bodyGap(tier),
    },
  ];
}

// ---------- the rows ----------

function rowNode(view: NetRowView, selected: boolean, current: boolean): HTMLElement {
  const node = row(view.startT, "prow-net", [
    cell(view.method, "pcell-method"),
    cell(view.url, "pcell-url"),
    cell(statusText(view), "pcell-status"),
    cell(view.resourceType === "" ? undefined : view.resourceType, "pcell-type"),
    cell(view.size, "pcell-size", formatBytes(view.size)),
    el("span", "pcell pcell-dur", view.durationMs === undefined ? "—" : formatMs(view.durationMs)),
  ]);
  node.dataset.state = view.state;
  node.dataset.requestId = view.requestId;
  node.dataset.key = view.key;
  if (view.orphan) node.dataset.orphan = "true";
  setSelected(node, selected);
  setCurrent(node, current);
  return node;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** The count line in the toolbar. It is always rendered, so a filter that
 *  changes it never moves the rows. */
export function statusLine(
  resolved: { total: number; matched: number },
  filter: NetFilter,
): string {
  return isFiltered(filter)
    ? `${resolved.matched.toLocaleString()} of ${plural(resolved.total, "request")} match`
    : plural(resolved.total, "request");
}

interface Ui {
  rows: readonly NetRow[];
  byKey: ReadonlyMap<string, NetRow>;
  tier: CaptureTier | undefined;
  filter: NetFilter;
  selected: string | undefined;
  /** The key last scrolled to, so playback scrolls when the current row
   *  changes and a redraw at the same place leaves the reviewer's scroll alone. */
  scrolledTo: string | undefined;
  table: HTMLElement;
  detail: HTMLElement;
  status: HTMLElement;
}

function drawTable(ui: Ui, t: number): void {
  const resolved = resolveNetwork(ui.rows, t, MAX_ROWS, ui.filter);
  ui.status.textContent = statusLine(resolved, ui.filter);
  ui.table.dataset.rowCount = String(resolved.rows.length);
  if (resolved.rows.length === 0) {
    ui.table.replaceChildren(
      emptyState(resolved.total === 0 ? NETWORK_NONE_YET : NETWORK_FILTERED),
    );
    ui.scrolledTo = undefined;
    return;
  }
  const currentKey = resolved.rows[resolved.rows.length - 1]?.key;
  const nodes: HTMLElement[] = [
    headRow("prow-net", ["Method", "URL", "Status", "Type", "Size", "Time"]),
  ];
  const note = overflowNote(resolved.hidden, "requests");
  if (note) nodes.push(note);
  for (const view of resolved.rows) {
    nodes.push(rowNode(view, view.key === ui.selected, view.key === currentKey));
  }
  replaceKeepingFocus(ui.table, nodes);
  if (currentKey !== ui.scrolledTo) {
    ui.scrolledTo = currentKey;
    const current = ui.table.querySelector<HTMLElement>('[data-current="true"]');
    current?.scrollIntoView({ block: "nearest" });
  }
}

function drawDetail(ui: Ui): void {
  const net = ui.selected === undefined ? undefined : ui.byKey.get(ui.selected);
  if (net === undefined) {
    clearDetail(ui.detail);
    return;
  }
  renderDetail(
    ui.detail,
    `${net.method} ${displayText(net.url, 120)}`,
    networkDetail(net, ui.tier),
  );
}

function selectRow(ui: Ui, key: string): void {
  ui.selected = key;
  for (const node of Array.from(ui.table.querySelectorAll<HTMLElement>(".prow[data-key]"))) {
    setSelected(node, node.dataset.key === key);
  }
  drawDetail(ui);
}

const STATUS_OPTIONS: readonly [NetStatusFilter, string][] = [
  ["all", "All statuses"],
  ["pending", "In flight"],
  ["ok", "Succeeded (below 400)"],
  ["error", "HTTP errors (400 and up)"],
  ["failed", "Failed to load"],
];

function statusSelect(): HTMLSelectElement {
  const select = el("select", "panel-filter") as HTMLSelectElement;
  select.id = "network-status";
  for (const [value, label] of STATUS_OPTIONS) {
    const option = el("option", undefined, label) as HTMLOptionElement;
    option.value = value;
    select.append(option);
  }
  return select;
}

export function networkPanel(): PanelDef {
  return {
    id: "network",
    title: "Network",
    eventTypes: [...NETWORK_EVENT_TYPES],
    mount(container: HTMLElement, api: PanelApi) {
      const rows = buildNetworkRows(api);
      if (rows.length === 0) {
        container.replaceChildren(
          emptyState(api.tier === "actions" ? NETWORK_NOT_CAPTURED : NETWORK_EMPTY),
        );
        return;
      }
      const text = textFilter("network-filter", "Filter");
      text.input.placeholder = "Method, URL, status or type";
      const statusLabel = el("label", "control", "Status ");
      const state = statusSelect();
      statusLabel.append(state);
      const status = el("span", "panel-status");
      const toolbar = el("div", "panel-toolbar");
      toolbar.append(text.label, statusLabel, status);

      const ui: Ui = {
        rows,
        byKey: new Map<string, NetRow>(rows.map((net): [string, NetRow] => [net.key, net])),
        tier: api.tier,
        filter: NO_NET_FILTER,
        selected: undefined,
        scrolledTo: undefined,
        table: el("div", "panel-table"),
        detail: detailPane("Request details"),
        status,
      };
      const split = el("div", "panel-split");
      split.append(ui.detail, ui.table);
      container.replaceChildren(toolbar, split);

      const draw = (): void => drawTable(ui, api.playhead());
      const refilter = (): void => {
        ui.filter = { text: text.input.value, state: state.value as NetStatusFilter };
        draw();
      };
      text.input.addEventListener("input", refilter);
      state.addEventListener("change", refilter);
      ui.table.addEventListener("click", (ev) => {
        const node = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".prow[data-key]");
        if (node?.dataset.key !== undefined) selectRow(ui, node.dataset.key);
      });
      api.onSeek(draw);
      draw();
    },
  };
}
