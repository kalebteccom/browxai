// The `android-app` SubstrateBundle. The native engine is the THIRD engine to
// supply its own bundle, after the shared Playwright one and Safari's, and it
// reads `e.session.native!()` exactly as the Safari bundle reads
// `e.session.safari!()`.
//
// FIVE PORTS ARE REAL AND FOUR REFUSE, AND THE SPLIT IS DECLARED, NOT HIDDEN.
// `android-app`'s capability row (`capabilities.ts`) declares `lifecycle`,
// `navigation`, `snapshot`, `input`, `capture` and `element`, and OMITS
// `network`, `storage`, `script` and `emulation`. The declaration is what makes
// the tools refuse — `subInterfaceGate` runs before the handler touches a
// substrate — and `sub-interface-conformance.test.ts` holds the two together.
//
// The four omitted positions are filled with a THROWING proxy rather than a
// plausible empty value. That is the lesson `SafariNoopNetworkSubstrate` taught:
// it answered `{total: 0, requests: []}` for a question Safari could not answer,
// and a well-formed "no traffic occurred" is indistinguishable from a true
// negative in a report a human is about to sign off. A native session genuinely
// has no cookies, no localStorage, no scriptable context and no media-query
// emulation, so the honest value is no value. The proxy shape is the architecture
// suite's own (`test/architecture/_synthetic-engine.ts`), used here for the same
// reason: it proves these ports are never reached on the shipped path, loudly.

import type { SessionEntry } from "../session/registry.js";
import type { SubstrateBundle, SubstrateDeps } from "../engine/registry.js";
// Through the engine BARREL, never the adapter module: `no-page-handler-to-
// engine-adapter-or-transport` keeps `src/page/**` off `src/engine/adapters/**`,
// and the Safari bundle reaches `SafariSessionHandle` the same way.
import type { NativeSessionHandle } from "../engine/index.js";
import type { ActionSubstrate } from "./action-substrate-types.js";
import type { CaptureSubstrate } from "./capture-substrate-types.js";
import type { ElementSubstrate } from "./element-substrate-types.js";
import type { EmulationSubstrate } from "./emulation-substrate-types.js";
import type { NetworkSubstrate } from "./network-substrate-types.js";
import type { ScriptSubstrate } from "./script-substrate-types.js";
import type { SnapshotSubstrate } from "./snapshot-substrate-types.js";
import type { StorageSubstrate } from "./storage-substrate-types.js";
import type { TargetSubstrate } from "./target-substrate-types.js";
import { NativeActionSubstrate } from "./action-substrate-android-app.js";
import { NativeCaptureSubstrate } from "./capture-substrate-android-app.js";
import { NativeElementSubstrate } from "./element-substrate-android-app.js";
import { NativeSnapshotSubstrate } from "./snapshot-substrate-android-app.js";
import { NativeTargetSubstrate } from "./target-substrate-android-app.js";

/** The engine tag every native substrate reports. */
export const ANDROID_APP_ENGINE = "android-app";

/** A port this engine declares no sub-interface for. Every member access throws,
 *  naming the port and the declaration that should have refused upstream — so a
 *  regression that removes the gate fails loudly on the first call instead of
 *  returning an empty answer nobody can distinguish from a real one. */
function unsupportedPort<T extends object>(port: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `android-app: the ${port} substrate must not be reached — the engine declares no ` +
            `"${port}" sub-interface, so subInterfaceGate refuses its tools first. Reached ` +
            `${port}.${String(prop)}. A native session has no ${port} to answer about, and a ` +
            "plausible empty answer here would be indistinguishable from a real one.",
        );
      },
    },
  ) as T;
}

/** The `android-app` bundle. Takes the per-server `SubstrateDeps` and uses the
 *  `save` sink for `screenshot({path})`, which keeps every write workspace-rooted
 *  through the same chokepoint the Playwright bundle uses. */
export function androidAppSubstrateBundle(deps: SubstrateDeps): SubstrateBundle {
  const handleOf = (e: SessionEntry): NativeSessionHandle => e.session.native!();
  /** One element adapter per session, named once because three bundle entries
   *  want it: the port itself, the action substrate's re-resolution, and the
   *  capture adapter's crop bounds. Minting it three times would be three objects
   *  over one session for no reason. */
  const elementsOf = (e: SessionEntry): NativeElementSubstrate =>
    new NativeElementSubstrate(handleOf(e).screen, e.refs, ANDROID_APP_ENGINE);
  return {
    actions: (e: SessionEntry): ActionSubstrate =>
      new NativeActionSubstrate(handleOf(e).device, elementsOf(e), ANDROID_APP_ENGINE),
    capture: (e: SessionEntry): CaptureSubstrate =>
      new NativeCaptureSubstrate(
        handleOf(e).device,
        elementsOf(e),
        { save: deps.save },
        ANDROID_APP_ENGINE,
      ),
    snapshot: (e: SessionEntry): SnapshotSubstrate =>
      new NativeSnapshotSubstrate(handleOf(e).screen, ANDROID_APP_ENGINE),
    target: (e: SessionEntry): TargetSubstrate =>
      new NativeTargetSubstrate(handleOf(e).device, ANDROID_APP_ENGINE),
    element: (e: SessionEntry): ElementSubstrate => elementsOf(e),
    // The four the engine declares no sub-interface for. See the module header.
    network: (): NetworkSubstrate => unsupportedPort<NetworkSubstrate>("network"),
    storage: (): StorageSubstrate => unsupportedPort<StorageSubstrate>("storage"),
    script: (): ScriptSubstrate => unsupportedPort<ScriptSubstrate>("script"),
    emulation: (): EmulationSubstrate => unsupportedPort<EmulationSubstrate>("emulation"),
  };
}
