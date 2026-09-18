// NativeNoNetworkSubstrate — the `network` position for an engine that CANNOT
// observe network at all, and the one that refuses instead of answering zero.
//
// WHY A SUBSTRATE AND NOT A THROWING PROXY. The first cut of this engine filled
// the four omitted ports with a proxy that threw on any access, on the theory
// that the gate refuses their tools upstream so nothing would reach them. The
// keystone against a real device disproved it in one run: `SessionRegistry`'s
// factory calls `network.attach()` at session creation, for EVERY engine, before
// any tool is involved. The wiring path is engine-blind by design — that is what
// `SafariNoopNetworkSubstrate`'s header means by "the rings construct, attach is
// a no-op, and nothing branches on the engine at wiring time".
//
// So the split is between WIRING and ANSWERING, and only answering refuses:
//
//   - `attach` / `setSecrets` — no-ops. There is nothing to attach to and no
//     egress sink to wire, and both are called by the session factory.
//   - `http.recent` / `ws.recent` / `ws.since` / `fetchBody` — THROW. This is the
//     `SafariNoopNetworkSubstrate` defect, named in `sub-interface-conformance`'s
//     header: it answered `{summary:{total:0}, requests:[]}` for a question
//     Safari could not answer, and a well-formed "no traffic occurred" is
//     indistinguishable from a true negative in a report a human is about to sign
//     off. `android-app` declares no `network` sub-interface, so
//     `subInterfaceGate` refuses `network_read` / `ws_read` / `network_body`
//     before they read a ring, and `export_session_report` substitutes a named
//     absence. These throws are the floor under that, not the mechanism.
//   - `route` / `unroute` — the shared structured refusal. Interception is where
//     a zero-valued answer is actively dangerous: "installed, 0 active" for a
//     route that was never installed means the agent asserts against a backend it
//     believes it stubbed.
//   - `openActionTap` — an EMPTY tap, and this one is a no-op on purpose. The
//     native action envelope is assembled by `native-actions.ts`, which never
//     opens a tap; the member exists for the engine-blind action window, and its
//     `warnings` already say the network delta is not captured on this engine.
//
// A native app has no protocol-level tap without a system proxy or a VPN
// profile, and installing either is the operator's decision, which browxai never
// makes on their behalf (RFC 0008, Honest limits).

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

/** The greppable reason. A test asserts on this instead of the prose. */
export const NATIVE_NO_NETWORK = "native-no-network-observation";

function unanswerable(member: string): never {
  throw new Error(
    `${NATIVE_NO_NETWORK}: the android-app engine cannot observe network traffic, so ` +
      `${member} has no answer. It declares no "network" sub-interface and the network tools ` +
      "refuse upstream; reaching this member means a gate is missing. Returning an empty result " +
      "here would be indistinguishable from a session that genuinely made no requests, which is " +
      "the worst possible value in a QA-evidence report.",
  );
}

export class NativeNoNetworkSubstrate implements NetworkSubstrate {
  readonly engine: string;

  constructor(engine = "android-app") {
    this.engine = engine;
  }

  readonly http: SessionNetworkRing = {
    setSecrets: () => undefined,
    // `iter` is the internal walk the ring's own consumers use; an empty
    // iteration is the honest answer to "what did we record", because nothing
    // was ever recorded. `recent` is the AGENT-FACING read and it refuses.
    iter: () => [],
    recent: () => unanswerable("network_read"),
  };

  readonly ws: SessionWsRing = {
    setSecrets: () => undefined,
    recent: () => unanswerable("ws_read"),
    since: () => unanswerable("ws_read"),
  };

  /** Wiring. Called by the session factory for every engine. */
  async attach(): Promise<void> {
    // Nothing to attach to — there is no protocol-level network domain here.
  }

  /** Wiring. No egress sink to mask, because nothing is ever captured. */
  setSecrets(): void {
    // Intentionally empty.
  }

  /** The engine-blind action window's per-action tap. Empty because the native
   *  action envelope is built elsewhere and says so in its own warnings. */
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
        `${NATIVE_NO_NETWORK}: network_body is not available on the android-app engine. There is ` +
        "no protocol-level tap on a native app without a system proxy or a VPN profile, and " +
        "installing either is the operator's decision.",
    };
  }

  async route(): Promise<RouteResult> {
    return routeInterceptionUnsupported("route", this.engine);
  }

  async unroute(): Promise<UnrouteResult> {
    return routeInterceptionUnsupported("unroute", this.engine);
  }
}
