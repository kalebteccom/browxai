// WebSocket / Server-Sent-Events frame capture (CDP substrate).
//
// The realtime slice of a session: anything that streams over a long-lived
// connection (chat, multiplayer, collaborative editing, live dashboards) is only
// observable at the frame level. `WsBuffer` is the session-wide analogue of
// `NetworkBuffer`: a bounded ring of recent WS/SSE frames, payloads truncated.
//
// The frame shape (`WsFrame`) and the egress sanitiser (`sanitizeFrame`) are
// shared with the off-Chromium Playwright WS ring (`network-playwright.ts`);
// they live here, the home of the WS concern, and are re-exported through the
// `./network.js` barrel so callers import them unchanged.

import type { CDPSession } from "playwright-core";
import type { SecretRegistry } from "../util/secrets.js";

// `WsFrame` (the frame shape) and `sanitizeFrame` (the egress sanitiser) are
// engine-blind domain, shared with the off-Chromium Playwright WS ring, so they
// live on the domain leaf `network-types.ts` alongside the HTTP shapes. Kept
// re-exported here because this module is the home of the WS concern and the
// `./network.js` barrel + `network-playwright.ts` both import them by this path.
export type { WsFrame } from "./network-types.js";
export { sanitizeFrame } from "./network-types.js";
import type { WsFrame } from "./network-types.js";
import { sanitizeFrame } from "./network-types.js";

export class WsBuffer {
  private urls = new Map<string, string>(); // requestId → endpoint url
  private ring: WsFrame[] = [];
  private enabled = false;
  /** Optional per-session secrets registry; egress masking is applied on
   *  every `recent` / `since` read. */
  private secrets: SecretRegistry | null = null;

  constructor(
    // CDP is the WS-tap substrate today; a later change will port it onto
    // Playwright's `page.on('websocket')` so non-CDP engines are supported.
    // On an engine without CDP (Firefox) the buffer
    // is constructed but never attaches — reads return empty until the
    // substrate port lands, rather than throwing at session creation.
    private cdp: CDPSession | undefined,
    private cap = 500,
    private maxPayload = 2000,
  ) {}

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
  }

  private trunc(s: string): { payload: string; truncated?: boolean } {
    if (s.length <= this.maxPayload) return { payload: s };
    return { payload: s.slice(0, this.maxPayload), truncated: true };
  }

  private push(f: WsFrame): void {
    this.ring.push(f);
    if (this.ring.length > this.cap) this.ring.shift();
  }

  async attach(): Promise<void> {
    if (this.enabled || !this.cdp) return;
    await this.cdp.send("Network.enable").catch(() => undefined); // idempotent w/ NetworkBuffer
    this.enabled = true;
    this.cdp.on("Network.webSocketCreated", (e: { requestId: string; url: string }) => {
      this.urls.set(e.requestId, e.url);
    });
    this.cdp.on(
      "Network.requestWillBeSent",
      (e: { requestId: string; request: { url: string }; type?: string }) => {
        if (e.type === "EventSource") this.urls.set(e.requestId, e.request.url);
      },
    );
    const onFrame =
      (dir: "sent" | "recv") =>
      (e: {
        requestId: string;
        timestamp?: number;
        response: { opcode: number; payloadData: string };
      }) => {
        this.push({
          url: this.urls.get(e.requestId) ?? "",
          dir,
          kind: "ws",
          opcode: e.response.opcode,
          ...this.trunc(e.response.payloadData ?? ""),
          ts: Date.now(),
        });
      };
    this.cdp.on("Network.webSocketFrameSent", onFrame("sent"));
    this.cdp.on("Network.webSocketFrameReceived", onFrame("recv"));
    this.cdp.on(
      "Network.eventSourceMessageReceived",
      (e: { requestId: string; eventName?: string; data: string }) => {
        this.push({
          url: this.urls.get(e.requestId) ?? "",
          dir: "recv",
          kind: "sse",
          event: e.eventName || undefined,
          ...this.trunc(e.data ?? ""),
          ts: Date.now(),
        });
      },
    );
  }

  /** Most-recent N frames, optionally filtered by a url substring. */
  recent(limit = 50, urlPattern?: string): { total: number; frames: WsFrame[] } {
    let frames = this.ring;
    // filter on the raw url, then sanitize the endpoint on the way out.
    if (urlPattern) frames = frames.filter((f) => f.url.includes(urlPattern));
    return {
      total: frames.length,
      frames: frames.slice(-limit).map((f) => sanitizeFrame(f, this.secrets)),
    };
  }

  /** Frames since a timestamp — for the per-action `ActionResult` slice. */
  since(ts: number, cap = 25): WsFrame[] {
    return this.ring
      .filter((f) => f.ts >= ts)
      .slice(-cap)
      .map((f) => sanitizeFrame(f, this.secrets));
  }
}
