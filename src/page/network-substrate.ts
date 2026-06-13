// The NetworkSubstrate interface — the engine-agnostic seam beneath the network
// tools (network_read / ws_read / network_body) and the per-action ActionResult
// network slice. It is the network side of RFC 0002 D5 (hybrid network substrate,
// Playwright events as the portable layer): the tools + the action window ask a
// substrate for "the session network ring", "the WS/SSE ring", "a per-action tap",
// and "a response body"; an engine-specific implementation answers.
//
// Dependency direction (architecture doctrine §1): tools / action-window →
// NetworkSubstrate (this interface) → implementation → CDP / Playwright events. A
// tool never reaches a CDPSession or a raw context event through this seam; the
// engine handle is captured at substrate construction, so the per-call surface
// carries no engine type. That is what un-couples the network slice from CDP and
// lets network_read / ws_read / network_body run on Firefox.
//
// Two implementations behind it (hybrid per D5):
//   - CdpNetworkSubstrate (chromium): owns the EXISTING NetworkBuffer / WsBuffer /
//     NetworkTap / fetchResponseBody CDP path VERBATIM — byte-identical buffers
//     and per-action tap, so the chromium keystones + unit tests stay green
//     unchanged. The CDP path is kept on chromium deliberately: the envelope is
//     browxai's hottest path and the benchmark (RFC open input #4) put the CDP
//     tap at parity with the event tap on chromium, so there is no reason to move
//     chromium off the substrate it already has.
//   - PlaywrightNetworkSubstrate (firefox / webkit): the Playwright context
//     `request` / `response` / `requestfailed` events feed the same NetworkBuffer
//     shape; `page.on('websocket')` `framesent` / `framereceived` feed the same
//     WsBuffer shape. network_body captures the response body at response time
//     (Playwright `response.body()`), because — unlike CDP `Network.getResponseBody`
//     — there is no after-the-fact body fetch off Chromium.
//
// Documented degradation off Chromium (honest, not a regression):
//   - resourceType nuance: Playwright `request.resourceType()` is lowercase and a
//     slightly coarser taxonomy than CDP's; mapped to the CDP-capitalised bucket
//     names so the noise-folding + `byType` summary stay identical in shape.
//   - timing precision: `ms` is wall-clock (request-seen → response-seen), the
//     same approximation the CDP tap uses — no high-resolution `timing()` deltas.
//   - body availability: bodies are captured at response time into a bounded LRU
//     keyed by a synthetic request id; a body for a request that predates the
//     capture window (or was evicted) is reported "not available", same best-
//     effort contract as the CDP renderer-discard behaviour.

import type { BrowserContext, CDPSession, Page } from "playwright-core";
import type { SecretRegistry } from "../util/secrets.js";
import {
  NetworkBuffer,
  WsBuffer,
  NetworkTap,
  fetchResponseBody,
  PlaywrightNetworkBuffer,
  PlaywrightWsBuffer,
  PlaywrightNetworkTap,
  type NetworkEntry,
  type NetworkSummary,
  type MutationEntry,
  type SessionNetworkRing,
  type SessionWsRing,
} from "./network.js";

/** The per-action network tap — opened before an action dispatches, closed after
 *  the settle window. `close()` returns the same `{summary, requests, mutations}`
 *  shape on every engine so the ActionResult envelope builder is engine-blind. */
export interface ActionNetworkTap {
  open(): Promise<void>;
  close(): Promise<{
    summary: NetworkSummary;
    requests: NetworkEntry[];
    mutations: MutationEntry[];
  }>;
}

/** The full-response-body result shape returned by `fetchBody` — the same shape
 *  `fetchResponseBody` (the CDP path) returns, so `network_body` is engine-blind. */
export interface FetchBodyResult {
  ok: boolean;
  body?: string;
  base64Encoded?: boolean;
  truncated?: boolean;
  error?: string;
}

/** The network observation source the network tools + the action window consume.
 *  One instance wraps one session's engine handle(s); the methods carry no engine
 *  type, so the surface above this seam is engine-agnostic. Mirrors the
 *  SnapshotSubstrate shape: an interface selected by capability, the handle
 *  captured at construction, the session-wide buffers owned here and attached
 *  once, no per-call allocation on the hot path beyond the per-action tap the CDP
 *  path already allocated. */
export interface NetworkSubstrate {
  /** Engine tag — for diagnostics + the per-engine keystone matrix. */
  readonly engine: string;
  /** Session-wide ring of recent HTTP requests (network_read; asset_export's
   *  `iter()`; session_metrics). Attached once at session creation. */
  readonly http: SessionNetworkRing;
  /** Session-wide ring of recent WebSocket / SSE frames (ws_read; the action
   *  window's `wsFrames` slice via `since()`). Attached once at session
   *  creation. */
  readonly ws: SessionWsRing;
  /** Attach the session-wide rings to their engine source. Idempotent. */
  attach(): Promise<void>;
  /** Wire the per-session secrets registry into every egress sink the substrate
   *  owns (both rings + the per-action taps it mints). */
  setSecrets(secrets: SecretRegistry): void;
  /** Mint a per-action tap for one action window. On chromium this is the
   *  verbatim CDP `NetworkTap`; off Chromium it is the Playwright-event tap. */
  openActionTap(): ActionNetworkTap;
  /** Fetch a full response body by request id (network_body, capability
   *  `network-body`). CDP fetches on demand; the Playwright path returns a body
   *  captured at response time. */
  fetchBody(requestId: string, secrets: SecretRegistry | null): Promise<FetchBodyResult>;
}

/** Chromium substrate — the existing CDP network path, moved behind the interface
 *  VERBATIM. The buffers are the same `NetworkBuffer` / `WsBuffer` constructed on
 *  the CDP handle, `openActionTap` mints the same `NetworkTap`, and `fetchBody`
 *  delegates to the same `fetchResponseBody`. Output is byte-identical to the
 *  pre-seam path, so the chromium keystones + unit tests are unchanged. The CDP
 *  handle is captured here once; callers never see it. */
export class CdpNetworkSubstrate implements NetworkSubstrate {
  readonly engine = "chromium";
  readonly http: NetworkBuffer;
  readonly ws: WsBuffer;
  private secrets: SecretRegistry | null = null;

  constructor(private readonly cdp: CDPSession) {
    this.http = new NetworkBuffer(cdp);
    this.ws = new WsBuffer(cdp);
  }

  async attach(): Promise<void> {
    await this.http.attach();
    await this.ws.attach();
  }

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
    this.http.setSecrets(secrets);
    this.ws.setSecrets(secrets);
  }

  openActionTap(): ActionNetworkTap {
    return new NetworkTap(this.cdp, this.secrets);
  }

  fetchBody(requestId: string, secrets: SecretRegistry | null): Promise<FetchBodyResult> {
    return fetchResponseBody(this.cdp, requestId, undefined, secrets);
  }
}

/** Firefox / WebKit substrate — the Playwright context-event network path. No
 *  CDP. The session-wide rings are `PlaywrightNetworkBuffer` / `PlaywrightWsBuffer`
 *  (the same ring shapes, fed by `context.on('request'|'response'|'requestfailed')`
 *  and `page.on('websocket')`). The per-action tap is the Playwright-event
 *  `PlaywrightNetworkTap`, and `fetchBody` reads from the body cache the buffer
 *  captured at response time. */
export class PlaywrightNetworkSubstrate implements NetworkSubstrate {
  readonly engine: string;
  readonly http: PlaywrightNetworkBuffer;
  readonly ws: PlaywrightWsBuffer;
  private secrets: SecretRegistry | null = null;

  constructor(
    private readonly context: BrowserContext,
    page: Page,
    engine = "firefox",
  ) {
    this.engine = engine;
    this.http = new PlaywrightNetworkBuffer(context);
    this.ws = new PlaywrightWsBuffer(page);
  }

  async attach(): Promise<void> {
    await this.http.attach();
    await this.ws.attach();
  }

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
    this.http.setSecrets(secrets);
    this.ws.setSecrets(secrets);
  }

  openActionTap(): ActionNetworkTap {
    return new PlaywrightNetworkTap(this.context, this.secrets);
  }

  fetchBody(requestId: string, secrets: SecretRegistry | null): Promise<FetchBodyResult> {
    return this.http.fetchBody(requestId, secrets);
  }
}
