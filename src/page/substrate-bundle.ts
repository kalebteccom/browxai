// The Playwright `SubstrateBundle` factory (RFC 0004 D1, pattern 1). Folds the
// five host-build.ts selectors (actionsFor / captureFor / storageFor / scriptFor /
// emulationFor) AND the two standalone selectors (snapshotSubstrateFor /
// networkSubstrateFor) into one engine-owned bundle, so the four Playwright
// engines (chromium / firefox / webkit / android) supply ONE substrate-bundle
// factory instead of seven scattered closures. Each selector body is byte-identical
// to its pre-fold form — only the home moves.
//
// The snapshot/network selectors stay capability-keyed (the engine's CDP presence,
// not its name): chromium/android (CDP) → the verbatim CDP substrate; firefox/
// webkit (Playwright Page, no CDP) → the page-side walker / event substrate. So a
// future CDP-bearing Playwright engine routes correctly with no edit here.
//
// `actions`/`capture` need host config (`ctxFor`'s testAttributes/originPolicy/caps,
// `describeTarget`, the screenshot `save` sink). The composition root (host-build)
// owns those per-server locals and passes its OWN set as the `deps` argument to
// `playwrightSubstrateBundle(deps)` — closed over here per server, NEVER a
// module-global. A module-global would let a second `createServer()` in the same
// process (the in-process SDK transport composes one server per transport)
// overwrite the first server's originPolicy / workspace.root / caps, cross-
// contaminating its sessions. Threading the deps explicitly keeps each server's
// bundle bound to its own boundary.

import type { SessionEntry } from "../session/registry.js";
import type { SubstrateBundle, SubstrateDeps } from "../engine/registry.js";
import { PlaywrightActionSubstrate, type ActionSubstrate } from "./action-substrate.js";
import { PlaywrightCaptureSubstrate, type CaptureSubstrate } from "./capture-substrate.js";
import { PlaywrightStorageSubstrate, type StorageSubstrate } from "./storage-substrate.js";
import { PlaywrightScriptSubstrate, type ScriptSubstrate } from "./script-substrate.js";
import { PlaywrightEmulationSubstrate, type EmulationSubstrate } from "./emulation-substrate.js";
import { type SnapshotSubstrate } from "./snapshot-substrate.js";
import { type NetworkSubstrate } from "./network-substrate.js";
import { snapshotSubstrateFor } from "./snapshot-substrate-select.js";
import { networkSubstrateFor } from "./network-substrate-select.js";

/** The Playwright `SubstrateBundle` — the four Playwright engines register this.
 *  `actions`/`capture` use the per-server host `deps` the composition root threads
 *  in (closed over here, not a module-global); `storage`/`script`/`emulation` wrap
 *  the session's Page/context; `snapshot`/`network` select by CDP presence. */
export function playwrightSubstrateBundle(deps: SubstrateDeps): SubstrateBundle {
  return {
    actions: (e: SessionEntry): ActionSubstrate =>
      new PlaywrightActionSubstrate(() => deps.ctxFor(e), e.session.engine),
    capture: (e: SessionEntry): CaptureSubstrate =>
      new PlaywrightCaptureSubstrate(() => e.session.page(), e.refs, {
        describeTarget: deps.describeTarget,
        save: deps.save,
      }),
    storage: (e: SessionEntry): StorageSubstrate =>
      new PlaywrightStorageSubstrate(
        () => e.session.page().context(),
        () => e.session.page(),
        e.session.engine,
      ),
    script: (e: SessionEntry): ScriptSubstrate =>
      new PlaywrightScriptSubstrate(() => e.session.page(), e.session.engine),
    emulation: (e: SessionEntry): EmulationSubstrate =>
      new PlaywrightEmulationSubstrate(
        () => e.session.page().context(),
        () => e.session.page(),
        e.session.engine,
      ),
    // Snapshot / network select by CDP presence — delegated to the existing
    // capability-keyed selectors (chromium/android → the verbatim CDP substrate;
    // firefox/webkit → the page-side walker / Playwright event substrate). The
    // selectors take the session, so the bundle threads `e.session` through —
    // byte-identical to the standalone `snapshotSubstrateFor` / `networkSubstrateFor`
    // the session-registry used inline, now owned by the engine's bundle.
    snapshot: (e: SessionEntry): SnapshotSubstrate => snapshotSubstrateFor(e.session),
    network: (e: SessionEntry): NetworkSubstrate => networkSubstrateFor(e.session),
  };
}
