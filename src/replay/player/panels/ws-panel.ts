/// <reference lib="dom" />
// The WebSocket panel (RFC 0007 P3). Connections from `ws/open`, their frames
// with direction, and the close, all resolved against the playhead the same way
// the network panel resolves a request.
//
// One correlation wrinkle the capture shape forces: `ws/open` and `ws/close`
// carry the CDP `requestId`, but a frame carries only its `url` (the session's
// WS/SSE ring is keyed that way). So frames attach to the most recent
// connection on the same URL that was already open when the frame arrived. A
// frame whose URL was never opened — every SSE stream, which has no `ws/open` at
// all — gets an inferred connection rather than being dropped. Dropping it would
// hide real traffic behind a correlation detail.

import type { ReplayEvent } from "../../schema.js";
import {
  numField,
  rawPayload,
  strField,
  timeOf,
  upToIndex,
  type EventIndex,
} from "./event-index.js";
import type { PanelApi, PanelDef } from "./panel-host.js";
import { cell, el, emptyState, formatMs, headRow, overflowNote, row } from "./panel-ui.js";

export const WS_EVENT_TYPES = ["ws/open", "ws/frame", "ws/close"] as const;

export const WS_EMPTY = "No WebSocket or SSE traffic in this artifact.";
export const WS_NONE_YET = "No connections had opened by this point on the timeline.";

const MAX_CONNECTIONS = 40;
const MAX_FRAMES = 120;

export interface WsFrameRow {
  t: number;
  dir: string;
  kind: string;
  payload: unknown;
  event?: string;
  truncated?: boolean;
}

export interface WsConnection {
  requestId: string;
  url: string;
  kind: string;
  openT: number;
  closeT?: number;
  closeCode?: number;
  closeReason?: string;
  frames: WsFrameRow[];
  /** No `ws/open` was in the log for this stream. */
  inferred?: boolean;
}

export interface WsConnectionView extends WsConnection {
  state: "open" | "closed";
  visibleFrames: WsFrameRow[];
  hiddenFrames: number;
  sent: number;
  received: number;
}

function frameRow(event: ReplayEvent): WsFrameRow {
  const p = rawPayload(event);
  const frame: WsFrameRow = {
    t: timeOf(event),
    dir: strField(event, "dir", "recv"),
    kind: strField(event, "kind", "ws"),
    payload: p.payload,
  };
  if (typeof p.event === "string") frame.event = p.event;
  if (p.truncated === true) frame.truncated = true;
  return frame;
}

function openConnection(event: ReplayEvent): WsConnection {
  return {
    requestId: strField(event, "requestId"),
    url: strField(event, "url"),
    kind: "ws",
    openT: timeOf(event),
    frames: [],
  };
}

/** Latest connection on this URL that was open when the frame arrived. */
function connectionFor(byUrl: Map<string, WsConnection[]>, url: string, t: number): WsConnection {
  const candidates = byUrl.get(url);
  if (candidates) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      const conn = candidates[i]!;
      if (conn.openT <= t) return conn;
    }
  }
  return { requestId: "", url, kind: "ws", openT: t, frames: [], inferred: true };
}

function track(
  conns: WsConnection[],
  byUrl: Map<string, WsConnection[]>,
  conn: WsConnection,
): void {
  conns.push(conn);
  const list = byUrl.get(conn.url);
  if (list) list.push(conn);
  else byUrl.set(conn.url, [conn]);
}

/** Correlate opens, frames and closes into one row per connection. Runs once,
 *  at mount. */
export function buildWsConnections(index: EventIndex): WsConnection[] {
  const conns: WsConnection[] = [];
  const byUrl = new Map<string, WsConnection[]>();
  const byId = new Map<string, WsConnection>();
  for (const event of index.byType("ws/open")) {
    const conn = openConnection(event);
    track(conns, byUrl, conn);
    byId.set(conn.requestId, conn);
  }
  for (const event of index.byType("ws/frame")) {
    const frame = frameRow(event);
    const conn = connectionFor(byUrl, strField(event, "url"), frame.t);
    if (conn.inferred && conn.frames.length === 0) {
      conn.kind = frame.kind;
      track(conns, byUrl, conn);
    }
    conn.frames.push(frame);
  }
  for (const event of index.byType("ws/close")) {
    const conn = byId.get(strField(event, "requestId"));
    if (!conn) continue;
    conn.closeT = timeOf(event);
    const code = numField(event, "code") ?? numField(event, "statusCode");
    if (code !== undefined) conn.closeCode = code;
    const reason = strField(event, "reason", strField(event, "errorText", ""));
    if (reason !== "") conn.closeReason = reason;
  }
  conns.sort((a, b) => a.openT - b.openT);
  return conns;
}

function viewOf(conn: WsConnection, t: number): WsConnectionView {
  const upTo = upToIndex(conn.frames, t, (f) => f.t);
  const from = Math.max(0, upTo - MAX_FRAMES);
  const visibleFrames = conn.frames.slice(from, upTo);
  let sent = 0;
  for (let i = 0; i < upTo; i++) if (conn.frames[i]!.dir === "sent") sent++;
  return {
    ...conn,
    state: conn.closeT !== undefined && conn.closeT <= t ? "closed" : "open",
    visibleFrames,
    hiddenFrames: from,
    sent,
    received: upTo - sent,
  };
}

/** Connections as they stood at `t`: none that had not opened, no frame that
 *  had not arrived, and a close that had not happened yet still reads as open. */
export function resolveWs(
  conns: readonly WsConnection[],
  t: number,
  limit = MAX_CONNECTIONS,
): { rows: WsConnectionView[]; hidden: number; total: number } {
  const total = upToIndex(conns, t, (c) => c.openT);
  const from = Math.max(0, total - limit);
  return { rows: conns.slice(from, total).map((c) => viewOf(c, t)), hidden: from, total };
}

export function closeText(view: WsConnectionView): string {
  if (view.state === "open") return "open";
  const code = view.closeCode === undefined ? "" : String(view.closeCode);
  const reason = view.closeReason ?? "";
  const detail = [code, reason].filter((s) => s !== "").join(" ");
  return detail === "" ? "closed" : `closed: ${detail}`;
}

function headerNode(view: WsConnectionView): HTMLElement {
  const node = row(view.openT, "prow-ws-head", [
    cell(view.url === "" ? "(no url)" : view.url, "pcell-url"),
    el("span", "pcell pcell-kind", view.kind),
    el("span", "pcell pcell-frames", `${view.sent}↑ ${view.received}↓`),
    el("span", "pcell pcell-state", closeText(view)),
  ]);
  node.dataset.state = view.state;
  if (view.inferred) node.dataset.inferred = "true";
  return node;
}

function frameNode(frame: WsFrameRow): HTMLElement {
  const dir = frame.dir === "sent" ? "sent" : "recv";
  const node = row(frame.t, "prow-ws-frame", [
    el("span", "pcell pcell-t", formatMs(frame.t)),
    el("span", "pcell pcell-dir", frame.event === undefined ? dir : `${dir} · ${frame.event}`),
    cell(frame.payload, "pcell-frame"),
  ]);
  node.dataset.dir = frame.dir;
  if (frame.truncated) node.dataset.truncated = "true";
  return node;
}

function connectionNode(view: WsConnectionView): HTMLElement {
  const block = el("div", "ws-conn");
  block.dataset.url = view.url;
  block.dataset.state = view.state;
  block.append(headerNode(view));
  const note = overflowNote(view.hiddenFrames, "frames");
  if (note) block.append(note);
  if (view.visibleFrames.length === 0) {
    block.append(el("div", "panel-note", "No frames yet on this connection."));
  } else {
    for (const frame of view.visibleFrames) block.append(frameNode(frame));
  }
  return block;
}

function render(container: HTMLElement, conns: readonly WsConnection[], t: number): void {
  if (conns.length === 0) {
    container.replaceChildren(emptyState(WS_EMPTY));
    return;
  }
  const resolved = resolveWs(conns, t);
  if (resolved.rows.length === 0) {
    container.replaceChildren(emptyState(WS_NONE_YET));
    return;
  }
  const nodes: HTMLElement[] = [headRow("prow-ws-head", ["URL", "Kind", "Frames", "State"])];
  const note = overflowNote(resolved.hidden, "connections");
  if (note) nodes.push(note);
  for (const view of resolved.rows) nodes.push(connectionNode(view));
  container.replaceChildren(...nodes);
  container.dataset.rowCount = String(resolved.rows.length);
}

export function wsPanel(): PanelDef {
  return {
    id: "ws",
    title: "WebSockets",
    eventTypes: [...WS_EVENT_TYPES],
    mount(container: HTMLElement, api: PanelApi) {
      const conns = buildWsConnections(api.index);
      const table = el("div", "panel-table");
      container.replaceChildren(table);
      api.onSeek((t) => render(table, conns, t));
      render(table, conns, api.playhead());
    },
  };
}
