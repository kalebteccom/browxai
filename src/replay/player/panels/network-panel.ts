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

import { isRedacted } from "../../schema.js";
import type { ReplayEvent } from "../../schema.js";
import {
  asObject,
  objField,
  rawPayload,
  strField,
  timeOf,
  windowUpTo,
  type EventIndex,
} from "./event-index.js";
import type { PanelApi, PanelDef } from "./panel-host.js";
import {
  cell,
  el,
  emptyState,
  formatBytes,
  formatMs,
  headRow,
  overflowNote,
  row,
} from "./panel-ui.js";

export const NETWORK_EVENT_TYPES = ["net/request", "net/response", "net/failed"] as const;

export const NETWORK_EMPTY =
  "No network events in this artifact. Capture at the replay tier or above records requests.";
export const NETWORK_NONE_YET = "No requests had been sent by this point on the timeline.";

/** Beyond this the panel is a wall, not a view. The window keeps the most
 *  recent rows before the playhead and says how many it left out. */
const MAX_ROWS = 300;

export type NetState = "pending" | "ok" | "error" | "failed";

export interface NetRow {
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
  return {
    requestId: strField(event, "requestId"),
    method: typeof request.method === "string" ? request.method : "GET",
    url: request.url,
    resourceType: strField(event, "type", ""),
    startT: timeOf(event),
  };
}

/**
 * Correlate the three network event types into one row per request. Runs once,
 * at mount.
 */
export function buildNetworkRows(index: EventIndex): NetRow[] {
  const rows: NetRow[] = [];
  const byId = new Map<string, NetRow>();
  for (const event of index.byType("net/request")) {
    const built = requestRow(event);
    rows.push(built);
    byId.set(built.requestId, built);
  }
  const orphan = (id: string, t: number, url: unknown, type: string): NetRow => {
    const made: NetRow = {
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
  for (const event of index.byType("net/response")) {
    const id = strField(event, "requestId");
    const response = objField(event, "response");
    const target = byId.get(id) ?? orphan(id, timeOf(event), response.url, strField(event, "type"));
    target.endT = timeOf(event);
    if (typeof response.status === "number") target.status = response.status;
    if (target.resourceType === "") target.resourceType = strField(event, "type");
    target.size = sizeOf(rawPayload(event), asObject(response.headers));
  }
  for (const event of index.byType("net/failed")) {
    const id = strField(event, "requestId");
    const target = byId.get(id) ?? orphan(id, timeOf(event), undefined, strField(event, "type"));
    target.endT = timeOf(event);
    target.error = strField(event, "errorText", rawPayload(event).canceled ? "canceled" : "failed");
  }
  rows.sort((a, b) => a.startT - b.startT);
  return rows;
}

function stateAt(net: NetRow, t: number): NetState {
  if (net.endT === undefined || net.endT > t) return "pending";
  if (net.error !== undefined) return "failed";
  return net.status !== undefined && net.status >= 400 ? "error" : "ok";
}

/** Rows as they stood at `t`: nothing that had not started, nothing resolved
 *  with an outcome that had not arrived. */
export function resolveNetwork(
  rows: readonly NetRow[],
  t: number,
  limit = MAX_ROWS,
): { rows: NetRowView[]; hidden: number; total: number } {
  const window = windowUpTo(rows, t, limit, (r) => r.startT);
  const views = window.rows.map((net) => {
    const state = stateAt(net, t);
    const view: NetRowView = { ...net, state };
    if (state === "pending") {
      delete view.status;
      delete view.size;
      delete view.error;
    } else if (net.endT !== undefined) view.durationMs = Math.max(0, net.endT - net.startT);
    return view;
  });
  return { rows: views, hidden: window.hidden, total: window.total };
}

export function statusText(view: NetRowView): string {
  if (view.state === "pending") return "in flight";
  if (view.state === "failed") return view.error ?? "failed";
  return view.status === undefined ? "—" : String(view.status);
}

function rowNode(view: NetRowView): HTMLElement {
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
  if (view.orphan) node.dataset.orphan = "true";
  return node;
}

function render(container: HTMLElement, rows: readonly NetRow[], t: number): void {
  if (rows.length === 0) {
    container.replaceChildren(emptyState(NETWORK_EMPTY));
    return;
  }
  const resolved = resolveNetwork(rows, t);
  if (resolved.rows.length === 0) {
    container.replaceChildren(emptyState(NETWORK_NONE_YET));
    return;
  }
  const nodes: HTMLElement[] = [
    headRow("prow-net", ["Method", "URL", "Status", "Type", "Size", "Time"]),
  ];
  const note = overflowNote(resolved.hidden, "requests");
  if (note) nodes.push(note);
  for (const view of resolved.rows) nodes.push(rowNode(view));
  container.replaceChildren(...nodes);
  container.dataset.rowCount = String(resolved.rows.length);
}

export function networkPanel(): PanelDef {
  return {
    id: "network",
    title: "Network",
    eventTypes: [...NETWORK_EVENT_TYPES],
    mount(container: HTMLElement, api: PanelApi) {
      const rows = buildNetworkRows(api.index);
      const table = el("div", "panel-table");
      container.replaceChildren(table);
      api.onSeek((t) => render(table, rows, t));
      render(table, rows, api.playhead());
    },
  };
}
