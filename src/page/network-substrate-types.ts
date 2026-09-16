// NetworkSubstrate port + result types — the engine-agnostic seam beneath the
// network tools (network_read / ws_read / network_body) and the per-action
// ActionResult network slice. The tools + the action window ask a substrate for
// "the session network ring", "the WS/SSE ring", "a per-action tap", and "a
// response body"; an engine-specific implementation answers.
//
// Dependency direction (architecture doctrine §1): tools / action-window →
// NetworkSubstrate (this port) → implementation → CDP / Playwright events /
// safaridriver. A tool never reaches a CDPSession or a raw context event through
// this seam; the engine handle is captured at substrate construction, so the
// per-call surface carries no engine type. That is what un-couples the network
// slice from CDP and lets network_read / ws_read / network_body run on Firefox.
// Split out of `network-substrate.ts` so the port module names no vendor type;
// the three implementations live in `network-substrate-cdp.ts`,
// `network-substrate-playwright.ts` and `network-substrate-safari.ts`.
// Re-exported through `./network-substrate.js` so callers import unchanged.
// (RFC 0009 P1.)

import type { SecretRegistry } from "../util/secrets.js";
import type {
  NetworkEntry,
  NetworkSummary,
  MutationEntry,
  SessionNetworkRing,
  SessionWsRing,
} from "./network-types.js";

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
