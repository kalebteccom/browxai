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
  type EventSource,
} from "./event-index.js";
import type { PanelApi, PanelDef } from "./panel-host.js";
import {
  cell,
  displayText,
  el,
  emptyState,
  formatMs,
  headRow,
  overflowNote,
  row,
} from "./panel-ui.js";

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
  /** As the log carried it: a string normally, the redaction marker if capture
   *  ever takes one out. Kept unnarrowed so the panel can tell "no url" from
   *  "a url was removed", which is the distinction the artifact exists to make. */
  url: unknown;
  /** What frames correlate on. Empty when the url was redacted or absent, which
   *  is honest: a url nobody can read is a url nobody can match on either. */
  urlKey: string;
  kind: string;
  openT: number;
  closeT?: number;
  closeCode?: number;
  closeReason?: string;
  frames: WsFrameRow[];
  /** No `ws/open` was in the log for this stream. */
  inferred?: boolean;
  /** `sentPrefix[i]` = how many of `frames[0..i)` were sent. Built once at
   *  mount, so the direction counts at a playhead are a lookup rather than a
   *  walk over every frame before it. */
  sentPrefix: number[];
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

function connection(url: unknown, openT: number, kind: string): WsConnection {
  return {
    requestId: "",
    url,
    urlKey: typeof url === "string" ? url : "",
    kind,
    openT,
    frames: [],
    sentPrefix: [],
  };
}

/**
 * The connection a frame belongs to: the latest one on its URL that was open
 * when the frame arrived.
 *
 * Both halves of that sentence are load-bearing. `openT <= t` because a url can
 * be reconnected and each connection owns only its own frames; not-yet-closed
 * because the previous connection on that url must not keep collecting after it
 * closed. Returns undefined when no candidate qualifies, and the caller infers
 * one — which is every SSE stream, since `ws/open` is a WebSocket event and an
 * EventSource never produces it.
 */
function connectionFor(
  byUrl: Map<string, WsConnection[]>,
  key: string,
  t: number,
): WsConnection | undefined {
  const candidates = byUrl.get(key);
  if (!candidates) return undefined;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const conn = candidates[i]!;
    if (conn.openT > t) continue;
    if (conn.closeT !== undefined && conn.closeT < t) continue;
    return conn;
  }
  return undefined;
}

/**
 * Track a connection, keeping the per-url list ordered by `openT`.
 *
 * Insertion order is NOT open order: a frame stamped by the WS ring's own clock
 * can land a millisecond before the CDP tap's `ws/open` for the same socket, and
 * the inferred connection that frame creates would otherwise sit after the real
 * one and win every backward scan from then on — a phantom row holding every
 * frame, next to a real row reading zero.
 */
function track(
  conns: WsConnection[],
  byUrl: Map<string, WsConnection[]>,
  conn: WsConnection,
): void {
  conns.push(conn);
  const list = byUrl.get(conn.urlKey);
  if (!list) {
    byUrl.set(conn.urlKey, [conn]);
    return;
  }
  let at = list.length;
  while (at > 0 && list[at - 1]!.openT > conn.openT) at--;
  list.splice(at, 0, conn);
}

function foldOpen(
  index: EventSource,
  conns: WsConnection[],
  byUrl: Map<string, WsConnection[]>,
  byId: Map<string, WsConnection>,
): void {
  for (const event of index.events("ws/open")) {
    const conn = connection(rawPayload(event).url, timeOf(event), "ws");
    conn.requestId = strField(event, "requestId");
    track(conns, byUrl, conn);
    byId.set(conn.requestId, conn);
  }
}

/** Closes fold BEFORE frames so `connectionFor` can see them. A close whose
 *  open never arrived gets its own row, the way the network panel keeps a
 *  response whose request it never saw: the socket existed, the log just starts
 *  mid-stream. */
function foldClose(
  index: EventSource,
  conns: WsConnection[],
  byUrl: Map<string, WsConnection[]>,
  byId: Map<string, WsConnection>,
): void {
  for (const event of index.events("ws/close")) {
    const id = strField(event, "requestId");
    const t = timeOf(event);
    let conn = byId.get(id);
    if (!conn) {
      conn = connection(rawPayload(event).url, t, "ws");
      conn.requestId = id;
      conn.inferred = true;
      track(conns, byUrl, conn);
      byId.set(id, conn);
    }
    conn.closeT = t;
    const code = numField(event, "code") ?? numField(event, "statusCode");
    if (code !== undefined) conn.closeCode = code;
    const reason = strField(event, "reason", strField(event, "errorText", ""));
    if (reason !== "") conn.closeReason = reason;
  }
}

function foldFrames(
  index: EventSource,
  conns: WsConnection[],
  byUrl: Map<string, WsConnection[]>,
): void {
  for (const event of index.events("ws/frame")) {
    const frame = frameRow(event);
    const url = rawPayload(event).url;
    const key = typeof url === "string" ? url : "";
    let conn = connectionFor(byUrl, key, frame.t);
    if (!conn) {
      conn = connection(url, frame.t, frame.kind);
      conn.inferred = true;
      track(conns, byUrl, conn);
    }
    conn.frames.push(frame);
  }
}

/** Correlate opens, closes and frames into one row per connection. Runs once,
 *  at mount. */
export function buildWsConnections(index: EventSource): WsConnection[] {
  const conns: WsConnection[] = [];
  const byUrl = new Map<string, WsConnection[]>();
  const byId = new Map<string, WsConnection>();
  foldOpen(index, conns, byUrl, byId);
  foldClose(index, conns, byUrl, byId);
  foldFrames(index, conns, byUrl);
  for (const conn of conns) {
    const prefix: number[] = [0];
    for (const frame of conn.frames) {
      prefix.push(prefix[prefix.length - 1]! + (frame.dir === "sent" ? 1 : 0));
    }
    conn.sentPrefix = prefix;
  }
  conns.sort((a, b) => a.openT - b.openT);
  return conns;
}

function viewOf(conn: WsConnection, t: number): WsConnectionView {
  const upTo = upToIndex(conn.frames, t, (f) => f.t);
  const from = Math.max(0, upTo - MAX_FRAMES);
  const visibleFrames = conn.frames.slice(from, upTo);
  const sent = conn.sentPrefix[upTo] ?? 0;
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

/** A url that is not a readable string: the redaction marker if something was
 *  taken out, and only otherwise the "nothing was there" reading. */
function urlText(view: WsConnectionView): string {
  return view.url === undefined || view.url === "" ? "(no url)" : displayText(view.url);
}

function headerNode(view: WsConnectionView): HTMLElement {
  const node = row(view.openT, "prow-ws-head", [
    cell(view.url, "pcell-url", view.urlKey === "" ? urlText(view) : view.urlKey),
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
  block.dataset.url = view.urlKey;
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
      const conns = buildWsConnections(api);
      const table = el("div", "panel-table");
      container.replaceChildren(table);
      api.onSeek((t) => render(table, conns, t));
      render(table, conns, api.playhead());
    },
  };
}
