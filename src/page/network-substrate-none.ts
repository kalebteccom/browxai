// `NoProtocolNetworkSubstrate` — the NetworkSubstrate position for an engine with
// no protocol-level network domain at all. Two engines are in that state today
// and for different reasons: safaridriver's WebDriver Classic has no network tap
// and Safari's experimental BiDi ships no `network` observation domain, while a
// native app has no protocol tap without a system proxy or a VPN profile —
// installing either is the operator's decision, which browxai never makes on
// their behalf (RFC 0008 §Honest limits).
//
// THE RINGS ARE NOT AN ANSWER. `http.recent()` returns
// `{summary:{total:0,…}, requests:[]}` — a well-formed "no traffic occurred" for a
// question the engine cannot answer, indistinguishable from a real result. That
// value must never reach an agent, and what keeps it from doing so is the
// DECLARATION, not this file: an engine here omits the `network` sub-interface, so
// `network_read` / `ws_read` / `network_body` each call
// `subInterfaceGate(tool, "network", e)` and refuse before touching a ring, and
// `export_session_report` substitutes a named absence for the summary. A substrate
// that threw instead would be the present-but-unconditionally-throwing port method
// RFC 0004 named as the L5 violation, so the refusal lives upstream at the gate,
// where it can say "the check was not performed".
// `test/architecture/sub-interface-conformance.test.ts` holds the gate and the
// declaration together.
//
// Interception is the exception, and it REFUSES: `{ok:true, active:[]}` for a
// route that was never installed would tell an agent it had stubbed a backend it
// had not, and the agent would then assert against the real one.

import type { SessionNetworkRing, SessionWsRing } from "./network.js";
import type {
  ActionNetworkTap,
  FetchBodyResult,
  NetworkSubstrate,
} from "./network-substrate-types.js";
import {
  routeInterceptionUnsupported,
  type RouteResult,
  type UnrouteResult,
} from "./route-types.js";

export class NoProtocolNetworkSubstrate implements NetworkSubstrate {
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

  /** `why` is rendered into `network_body`'s refusal, so each engine says what is
   *  actually missing rather than sharing one vague sentence. */
  constructor(
    readonly engine: string,
    private readonly why: string,
  ) {}

  async attach(): Promise<void> {
    // Nothing to attach to — there is no protocol-level network domain here.
  }

  setSecrets(): void {
    // No egress sinks to wire — the rings and the tap are permanently empty.
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
      error: `network_body is not available on the ${this.engine} engine — ${this.why}`,
    };
  }

  async route(): Promise<RouteResult> {
    return routeInterceptionUnsupported("route", this.engine);
  }

  async unroute(): Promise<UnrouteResult> {
    return routeInterceptionUnsupported("unroute", this.engine);
  }
}
