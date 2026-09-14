// Network + WS/SSE tap for the replay log (RFC 0007). Split out of
// `session.ts` so the orchestrator stays under the file-size budget while the
// tap wiring keeps its own cohesive module — Playwright/CDP boundary casts,
// body-fetch discipline, WS frame cap and SSE URL fallback all in one place.
//
// Parallels `src/page/network-cdp.ts` + `src/page/network-ws.ts` for the same
// reason WsBuffer does: the two rings feed different consumers (the replay
// log here, `ws_read` / `ActionResult` there) and neither is a subscriber on
// the other. Cost is one extra CDP listener per event; benefit is zero
// coupling between hot capture paths.

import type { CDPSession } from "playwright-core";

import { log } from "../util/logging.js";
import type { ReplayLog } from "./log.js";
import type { CaptureTier } from "./schema.js";
import {
  netFailedEvent,
  netRequestEvent,
  netResponseEvent,
  wsCloseEvent,
  wsFrameEvent,
  wsOpenEvent,
  type CdpLoadingFailed,
  type CdpRequestWillBeSent,
  type CdpResponseReceived,
  type SourceContext,
} from "./sources.js";

/** Per-frame payload character cap, mirroring `WsBuffer`'s ring in
 *  `src/page/network-ws.ts`. Binary WS streams (video, WebRTC data channels)
 *  can push megabyte frames at rate; without a cap those land raw on the log's
 *  synchronous hot path and either burn the pending-write budget (backpressure
 *  drops) or trip `size-cap` early. Truncation is per frame, not per stream —
 *  the schema's `WsFramePayload.truncated: boolean` records it. */
export const WS_MAX_PAYLOAD = 2000;

/** Result of `attachReplayNetwork`: the caller's detach hook and the set of
 *  in-flight body fetches `end()` awaits before closing the log. */
export interface NetworkTapHandle {
  detach: () => void;
  pendingBodyFetches: Set<Promise<void>>;
}

export async function attachReplayNetwork(
  cdp: CDPSession,
  ctx: SourceContext,
  rlog: ReplayLog,
  tier: CaptureTier,
): Promise<NetworkTapHandle | undefined> {
  try {
    await cdp.send("Network.enable");
  } catch (err) {
    log.warn("replay.session: Network.enable failed; network stream will be empty", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const pendingBodyFetches = new Set<Promise<void>>();
  const detachHttp = attachHttp(cdp, ctx, rlog, tier, pendingBodyFetches);
  const detachWs = attachWs(cdp, ctx, rlog);
  return {
    pendingBodyFetches,
    detach: () => {
      detachHttp();
      detachWs();
    },
  };
}

function attachHttp(
  cdp: CDPSession,
  ctx: SourceContext,
  rlog: ReplayLog,
  tier: CaptureTier,
  pendingBodyFetches: Set<Promise<void>>,
): () => void {
  const onRequest = (payload: unknown): void => {
    rlog.append(netRequestEvent(ctx, payload as CdpRequestWillBeSent));
  };
  const onResponse = (payload: unknown): void => {
    const e = payload as CdpResponseReceived;
    // Stamp `t` when the response arrived, not when the body fetch resolves —
    // otherwise `net/response` is timestamp-skewed from its own `net/request`
    // and the player renders responses out of order relative to requests.
    const wallMs = Date.now();
    if (tier !== "reexecutable") {
      rlog.append(netResponseEvent(ctx, e, { wallMs }));
      return;
    }
    // Track the promise: `end()` awaits it so an in-flight fetch that resolved
    // after the log closed cannot land its append on a shut handle.
    const p: Promise<void> = fetchBody(cdp, e.requestId)
      .catch(() => undefined)
      .then((body) => {
        const opts: { body?: string; wallMs: number } = { wallMs };
        if (body !== undefined) opts.body = body;
        rlog.append(netResponseEvent(ctx, e, opts));
      })
      .finally(() => {
        pendingBodyFetches.delete(p);
      });
    pendingBodyFetches.add(p);
  };
  const onFailed = (payload: unknown): void => {
    rlog.append(netFailedEvent(ctx, payload as CdpLoadingFailed));
  };
  cdp.on("Network.requestWillBeSent", onRequest);
  cdp.on("Network.responseReceived", onResponse);
  cdp.on("Network.loadingFailed", onFailed);
  return (): void => {
    cdp.off("Network.requestWillBeSent", onRequest);
    cdp.off("Network.responseReceived", onResponse);
    cdp.off("Network.loadingFailed", onFailed);
  };
}

/** Mirror the network-ws.ts CDP tap onto the replay log. Two payload
 *  disciplines mirror WsBuffer: the per-frame cap (`WS_MAX_PAYLOAD`) so a
 *  binary stream cannot burn the log's pending-write budget on the sync hot
 *  path; and the SSE URL fallback via `Network.requestWillBeSent` —
 *  `webSocketCreated` never fires for EventSource, so without this every SSE
 *  frame ships with an empty `url` and the panel collapses every endpoint's
 *  stream into one unnamed row. */
function attachWs(cdp: CDPSession, ctx: SourceContext, rlog: ReplayLog): () => void {
  const urls = new Map<string, string>();
  const trunc = (s: string): { payload: string; truncated?: boolean } =>
    s.length <= WS_MAX_PAYLOAD
      ? { payload: s }
      : { payload: s.slice(0, WS_MAX_PAYLOAD), truncated: true };
  const onCreated = (payload: unknown): void => {
    const e = payload as { requestId: string; url: string };
    urls.set(e.requestId, e.url);
    rlog.append(wsOpenEvent(ctx, { requestId: e.requestId, url: e.url }));
  };
  const onRequestForSse = (payload: unknown): void => {
    const e = payload as { requestId: string; request: { url: string }; type?: string };
    if (e.type === "EventSource") urls.set(e.requestId, e.request.url);
  };
  const onFrame =
    (dir: "sent" | "recv") =>
    (payload: unknown): void => {
      const e = payload as {
        requestId: string;
        response: { opcode: number; payloadData: string };
      };
      const capped = trunc(e.response.payloadData ?? "");
      rlog.append(
        wsFrameEvent(ctx, {
          url: urls.get(e.requestId) ?? "",
          dir,
          kind: "ws",
          opcode: e.response.opcode,
          ...capped,
        }),
      );
    };
  const onSse = (payload: unknown): void => {
    const e = payload as { requestId: string; eventName?: string; data: string };
    const capped = trunc(e.data ?? "");
    rlog.append(
      wsFrameEvent(ctx, {
        url: urls.get(e.requestId) ?? "",
        dir: "recv",
        kind: "sse",
        ...(e.eventName ? { event: e.eventName } : {}),
        ...capped,
      }),
    );
  };
  const onClosed = (payload: unknown): void => {
    const e = payload as { requestId: string };
    urls.delete(e.requestId);
    rlog.append(wsCloseEvent(ctx, { requestId: e.requestId }));
  };
  const sent = onFrame("sent");
  const recv = onFrame("recv");
  cdp.on("Network.requestWillBeSent", onRequestForSse);
  cdp.on("Network.webSocketCreated", onCreated);
  cdp.on("Network.webSocketFrameSent", sent);
  cdp.on("Network.webSocketFrameReceived", recv);
  cdp.on("Network.eventSourceMessageReceived", onSse);
  cdp.on("Network.webSocketClosed", onClosed);
  return (): void => {
    cdp.off("Network.requestWillBeSent", onRequestForSse);
    cdp.off("Network.webSocketCreated", onCreated);
    cdp.off("Network.webSocketFrameSent", sent);
    cdp.off("Network.webSocketFrameReceived", recv);
    cdp.off("Network.eventSourceMessageReceived", onSse);
    cdp.off("Network.webSocketClosed", onClosed);
  };
}

async function fetchBody(cdp: CDPSession, requestId: string): Promise<string | undefined> {
  const r = (await cdp.send("Network.getResponseBody", { requestId })) as {
    body: string;
    base64Encoded?: boolean;
  };
  if (!r) return undefined;
  return r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
}
