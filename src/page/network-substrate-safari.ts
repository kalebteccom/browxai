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

import { NoProtocolNetworkSubstrate } from "./network-substrate-none.js";

/** Safari substrate — a NO-OP, and `NoProtocolNetworkSubstrate` is the body.
 *  Safari was the first engine with no protocol-level network domain and RFC
 *  0008's native engines are the second, so the shape moved to a shared base
 *  rather than being copied a second time. This subclass is the safari NAME (the
 *  engine tag diagnostics read) plus the safari-specific reason `network_body`
 *  renders. Behaviour is unchanged. */
export class SafariNoopNetworkSubstrate extends NoProtocolNetworkSubstrate {
  constructor() {
    super(
      "safari",
      "Safari exposes no protocol-level network observation. Use a chromium/firefox/webkit " +
        "session for network bodies.",
    );
  }
}
