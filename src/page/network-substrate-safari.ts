// SafariNoopNetworkSubstrate — a NO-OP NetworkSubstrate. Real Safari has NO
// protocol-level network observation or interception at all: safaridriver's
// WebDriver Classic has no network tap, and Safari's experimental BiDi ships only
// `network.setCacheBehavior` (the `network` observation domain is absent). So the
// network tools are capability-gated on Safari and the action-window network slice
// is empty. This empty substrate keeps the session-creation + envelope code
// engine-blind: the rings are always empty, the per-action tap reports zero
// traffic, and `network_body` returns a structured "not available". It is never
// the source of truth for any surfaced network claim — the gate refuses the tools
// first.
//
// Dependency direction (architecture doctrine §1): tools / action-window →
// NetworkSubstrate (the port in `network-substrate-types.ts`) → this
// implementation. This file never imports back from the `network-substrate.js`
// barrel.

import type { SessionNetworkRing, SessionWsRing } from "./network.js";
import type {
  ActionNetworkTap,
  FetchBodyResult,
  NetworkSubstrate,
} from "./network-substrate-types.js";

/** Safari substrate — a NO-OP. Real Safari has NO protocol-level
 *  network observation or interception at all: safaridriver's WebDriver Classic
 *  has no network tap, and Safari's experimental BiDi ships only
 *  `network.setCacheBehavior` (the `network` observation domain is absent). So
 *  the network tools are
 *  capability-gated on Safari and the action-window network slice is empty. This
 *  empty substrate keeps the session-creation + envelope code engine-blind: the
 *  rings are always empty, the per-action tap reports zero traffic, and
 *  `network_body` returns a structured "not available". It is never the source of
 *  truth for any surfaced network claim — the gate refuses the tools first. */
export class SafariNoopNetworkSubstrate implements NetworkSubstrate {
  readonly engine = "safari";
  readonly http: SessionNetworkRing = {
    setSecrets: () => undefined,
    iter: () => [],
    recent: () => ({ summary: { total: 0, byType: {}, failed: 0 }, requests: [] }),
  };
  readonly ws: SessionWsRing = {
    setSecrets: () => undefined,
    recent: () => ({ total: 0, frames: [] }),
    since: () => [],
  };

  async attach(): Promise<void> {
    // Nothing to attach to — Safari has no protocol-level network domain.
  }

  setSecrets(): void {
    // No egress sinks to wire — the rings + tap are permanently empty on Safari.
  }

  openActionTap(): ActionNetworkTap {
    return {
      open: () => Promise.resolve(),
      close: () =>
        Promise.resolve({
          summary: { total: 0, byType: {}, failed: 0 },
          requests: [],
          mutations: [],
        }),
    };
  }

  async fetchBody(): Promise<FetchBodyResult> {
    return {
      ok: false,
      error:
        "network_body is not available on the safari engine — Safari exposes no protocol-level " +
        "network observation. Use a chromium/firefox/webkit session for network bodies.",
    };
  }
}
