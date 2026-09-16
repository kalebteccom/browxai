// The `SubstrateDeps` set for callers that resolve ONLY a session's snapshot and
// network substrates.
//
// `EngineEntry.makeSubstrates(deps)` is one factory for all eight selectors, and
// four of them (actions / capture / storage / script / emulation) close over host
// locals the session layer has no business holding — `ctxFor` carries the
// server's origin policy and capability gate, `save` writes under its workspace
// root. The snapshot and network selectors read `e.session` and nothing else.
//
// So a snapshot/network-only caller passes THIS: the two it needs are resolvable,
// and the four it must never drive throw a message naming the module that owns
// them. Shared by the session registry (first wiring) and the extension-context
// rebuild (re-wiring after a relaunch), which is what keeps both on the
// engine-owned bundle instead of reaching past it into `snapshotSubstrateFor` /
// `networkSubstrateFor` directly. (RFC 0009 — the engine owns substrate
// selection.)

import type { SubstrateDeps } from "../engine/registry.js";

/** Build the throwing-deps set. A function, not a shared constant: each caller
 *  names itself in the refusal, so a stack-free error still says which module
 *  drove a substrate it had no deps for. */
export function snapshotNetworkOnlyDeps(caller: string): SubstrateDeps {
  const refuse = (selector: string, owner: string): never => {
    throw new Error(
      `${caller}: ${selector} must not be reached — this caller resolves only the ` +
        `snapshot/network substrates (${owner}).`,
    );
  };
  return {
    ctxFor: () => refuse("ctxFor", "action/capture are host-build's concern"),
    describeTarget: () => refuse("describeTarget", "capture is host-build's concern"),
    save: () => refuse("save", "capture is host-build's concern"),
  };
}
