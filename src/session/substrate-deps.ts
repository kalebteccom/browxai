// The `SubstrateDeps` set for callers that hold none of the server's host config.
//
// `EngineEntry.makeSubstrates(deps)` is one factory for all eight selectors, and
// three host closures feed them: `ctxFor` carries the server's origin policy and
// capability gate, `describeTarget` and `save` belong to the screenshot path and
// `save` writes under the server's workspace root. The session layer has no
// business holding any of them.
//
// So a host-free caller passes THIS. The selectors it needs are resolvable, and
// each host closure throws a message naming the module that owns it — LAZILY,
// when the closure is called rather than when the bundle is built. That is what
// makes the set usable for a whole port minus the members that reach host config:
// the session registry's teardown resolves the CAPTURE port to take
// `prepareVideoSave`, which needs no host closure, while `screenshot` on the same
// object still refuses.
//
// Shared by the session registry (first wiring, plus the teardown video flush)
// and the extension-context rebuild (re-wiring after a relaunch), which is what
// keeps both on the engine-owned bundle instead of reaching past it into
// `snapshotSubstrateFor` / `networkSubstrateFor` directly. (RFC 0009 — the engine
// owns substrate selection.)

import type { SubstrateDeps } from "../engine/registry.js";

/** Build the throwing-deps set. A function, not a shared constant: each caller
 *  names itself in the refusal, so a stack-free error still says which module
 *  drove a substrate member it had no deps for. */
export function hostFreeSubstrateDeps(caller: string): SubstrateDeps {
  const refuse = (closure: string, owner: string): never => {
    throw new Error(
      `${caller}: ${closure} must not be reached — this caller holds none of the ` +
        `server's host config (${owner}).`,
    );
  };
  return {
    ctxFor: () => refuse("ctxFor", "the action dispatch context is host-build's concern"),
    describeTarget: () =>
      refuse("describeTarget", "the screenshot caption is host-build's concern"),
    save: () => refuse("save", "the screenshot disk write is host-build's concern"),
  };
}
