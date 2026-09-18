// The `android-app` SubstrateBundle. The native engine is the THIRD engine to
// supply its own bundle, after the shared Playwright one and Safari's, and it
// reads `e.session.native!()` exactly as the Safari bundle reads
// `e.session.safari!()`.
//
// SIX PORTS ARE REAL AND THREE REFUSE, AND THE SPLIT IS DECLARED, NOT HIDDEN.
// `android-app`'s capability row (`capabilities.ts`) declares `lifecycle`,
// `navigation`, `snapshot`, `input`, `capture` and `element`, and OMITS
// `network`, `storage`, `script` and `emulation`. The declaration is what makes
// the tools refuse — `subInterfaceGate` runs before the handler touches a
// substrate — and `sub-interface-conformance.test.ts` holds the two together.
//
// NO OMITTED PORT ANSWERS A PLAUSIBLE EMPTY. That is the lesson
// `SafariNoopNetworkSubstrate` taught: it answered `{total: 0, requests: []}` for
// a question Safari could not answer, and a well-formed "no traffic occurred" is
// indistinguishable from a true negative in a report a human is about to sign
// off. A native session genuinely has no cookies, no localStorage, no scriptable
// context and no media-query emulation, so the honest value is no value.
//
// `storage` / `script` / `emulation` are a THROWING PROXY — the architecture
// suite's own shape (`test/architecture/_synthetic-engine.ts`), used here for the
// same reason: it proves these ports are never reached on the shipped path,
// loudly. `network` needed a real adapter, and finding that out is what the
// keystone against a device bought: the session factory calls `network.attach()`
// for EVERY engine at wiring time, before any tool is involved, so a proxy there
// broke session creation itself. `network-substrate-android-app.ts` splits wiring
// from answering — the wiring members no-op and the agent-facing reads throw.

import type { SessionEntry } from "../session/registry.js";
import type { SubstrateBundle, SubstrateDeps } from "../engine/registry.js";
// Through the engine BARREL, never the adapter module: `no-page-handler-to-
// engine-adapter-or-transport` keeps `src/page/**` off `src/engine/adapters/**`,
// and the Safari bundle reaches `SafariSessionHandle` the same way.
import type { AndroidNativeHandle } from "../engine/index.js";
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
import { NativeNoNetworkSubstrate } from "./network-substrate-android-app.js";

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
  // `BrowserSession.native()` is one member serving both native engines, so the
  // engine's own bundle narrows it to the handle that engine built. Same shape as
  // the Safari bundle's `e.session.safari!()`, and reached only from a bundle the
  // registry hands out for THIS engine.
  const handleOf = (e: SessionEntry): AndroidNativeHandle =>
    e.session.native!() as AndroidNativeHandle;
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
    // `network` is the one omitted port with a REAL adapter, because the session
    // factory calls `attach()` on it for every engine at wiring time — the
    // keystone against a real device found that in one run. Its wiring members
    // no-op and its agent-facing reads throw; see the module header there.
    network: (): NetworkSubstrate => new NativeNoNetworkSubstrate(ANDROID_APP_ENGINE),
    // The three the engine declares no sub-interface for and nothing reaches.
    storage: (): StorageSubstrate => unsupportedPort<StorageSubstrate>("storage"),
    script: (): ScriptSubstrate => unsupportedPort<ScriptSubstrate>("script"),
    emulation: (): EmulationSubstrate => unsupportedPort<EmulationSubstrate>("emulation"),
  };
}
