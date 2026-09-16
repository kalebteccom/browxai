// SafariNoopNetworkSubstrate — a NO-OP NetworkSubstrate. Real Safari has NO
// protocol-level network observation or interception at all: safaridriver's
// WebDriver Classic has no network tap, and Safari's experimental BiDi ships only
// `network.setCacheBehavior` (the `network` observation domain is absent). So
// Safari declares no `network` sub-interface, and this empty substrate exists to
// keep the session-creation + envelope code engine-blind: the rings construct,
// attach is a no-op, and nothing branches on the engine at wiring time.
//
// THE RINGS ARE NOT AN ANSWER. `http.recent()` returns
// `{summary:{total:0,…}, requests:[]}` — a well-formed "no traffic occurred" for
// a question this engine cannot answer, indistinguishable from a real result and
// unmarked as a non-answer. That value must never reach an agent. What keeps it
// from doing so is the DECLARATION, not this file: `network_read` / `ws_read` /
// `network_body` each call `subInterfaceGate(tool, "network", e)` and return a
// structured refusal before they touch the ring, and `export_session_report`
// substitutes a named absence for the summary. A substrate that threw instead
// would be the present-but-unconditionally-throwing port method RFC 0004 named as
// the L5 violation, so the refusal lives upstream at the gate, where it can say
// "the check was not performed". `test/architecture/sub-interface-conformance.test.ts`
// holds the gate and the declaration together. (RFC 0004 D5; RFC 0009.)
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

/** Safari substrate — a NO-OP. Wiring-time engine-blindness only: the rings
 *  construct and stay empty, the per-action tap reports zero traffic, and
 *  `network_body` returns a structured "not available". The empty rings are NOT
 *  an answer and must never be surfaced — Safari declares no `network`
 *  sub-interface, and the tools refuse on that declaration before reading them.
 *  See the module header. */
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
