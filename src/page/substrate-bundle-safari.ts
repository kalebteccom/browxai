// The Safari `SubstrateBundle` factory (RFC 0004 D1, pattern 1). Safari is the
// no-Playwright-Page engine, so its seven substrate selectors all read the
// Safari-native handle (`e.session.safari!()`) instead of a Page/CDP. Each body
// is byte-identical to its pre-fold form: the five host-build.ts Safari branches
// (the `if (safariHandle) return new SafariXSubstrate(...)` legs), the Safari
// snapshot selector (the `SafariSnapshotIO` {exec, currentUrl} wrapping at
// snapshot-substrate-select.ts:46-50), and the Safari no-op network substrate.

import type { SessionEntry } from "../session/registry.js";
import type { SubstrateBundle, SubstrateDeps } from "../engine/registry.js";
import { SafariActionSubstrate, type ActionSubstrate } from "./action-substrate.js";
import { SafariCaptureSubstrate, type CaptureSubstrate } from "./capture-substrate.js";
import { SafariStorageSubstrate, type StorageSubstrate } from "./storage-substrate.js";
import { SafariScriptSubstrate, type ScriptSubstrate } from "./script-substrate.js";
import { SafariEmulationSubstrate, type EmulationSubstrate } from "./emulation-substrate.js";
import { type SnapshotSubstrate } from "./snapshot-substrate.js";
import { SafariClassicSnapshotSubstrate } from "./snapshot-substrate-safari.js";
import { SafariNoopNetworkSubstrate, type NetworkSubstrate } from "./network-substrate.js";

/** The Safari `SubstrateBundle` — the safari engine registers this. `safari!()` is
 *  the Safari-native WebDriver-Classic + BiDi handle, present on every safari
 *  session by construction (the safari `BrowserSession` always supplies it). Takes
 *  the per-server `SubstrateDeps` to honour the standardized `makeSubstrates(deps)`
 *  contract, but ignores them: every Safari selector reads the Safari-native handle,
 *  not the Playwright `ctxFor`/`describeTarget`/`save` deps. */
export function safariSubstrateBundle(_deps: SubstrateDeps): SubstrateBundle {
  return {
    actions: (e: SessionEntry): ActionSubstrate =>
      new SafariActionSubstrate(e.session.safari!(), e.refs),
    capture: (e: SessionEntry): CaptureSubstrate =>
      new SafariCaptureSubstrate(e.session.safari!()),
    storage: (e: SessionEntry): StorageSubstrate =>
      new SafariStorageSubstrate(e.session.safari!()),
    script: (e: SessionEntry): ScriptSubstrate =>
      new SafariScriptSubstrate(e.session.safari!()),
    emulation: (e: SessionEntry): EmulationSubstrate =>
      new SafariEmulationSubstrate(e.session.safari!()),
    snapshot: (e: SessionEntry): SnapshotSubstrate => {
      // SafariClassicSnapshotSubstrate takes a SafariSnapshotIO seam
      // ({ exec, currentUrl }), not the raw handle — exactly the wrapping the live
      // snapshot-substrate-select.ts:46-50 did.
      const handle = e.session.safari!();
      return new SafariClassicSnapshotSubstrate({
        exec: (scriptBody, args) =>
          handle.webDriver.executeScript(handle.sessionId, scriptBody, args),
        currentUrl: () => handle.webDriver.currentUrl(handle.sessionId),
      });
    },
    // Safari has no protocol-level network at all (no CDP tap, no BiDi network
    // domain) — the empty no-op substrate; the network tools are capability-gated.
    network: (): NetworkSubstrate => new SafariNoopNetworkSubstrate(),
  };
}
