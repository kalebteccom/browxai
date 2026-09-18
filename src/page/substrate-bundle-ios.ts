// The ios-app `SubstrateBundle` factory — the engine's own answer to "which
// adapter serves each capability", the shape `substrate-bundle-safari.ts`
// established for an engine with no Playwright `Page`. Every selector reads the
// native handle (`handleOf(e)`), present on every ios-app session by
// construction.
//
// Five of the nine are REAL: snapshot (the XCUITest hierarchy), element
// (resolution and reads over a fresh dump), actions (taps, set-value, key input,
// scroll and the two gesture primitives), capture (simctl screenshots) and target
// (the `app://` scope and the foreground app's name).
//
// Four are ABSENT, and the engine's capability row omits each one so the gate
// refuses their tools upstream. What each absent substrate does beneath the gate
// differs by what its port can express, and the difference is deliberate:
// emulation returns refusal objects because its result type has a refusal member;
// storage and script THROW because theirs return data and a plausible empty is the
// worse answer; network keeps empty rings because the session-creation path
// attaches them before any tool runs, and its one dangerous member — route
// interception — refuses.

import type { SessionEntry } from "../session/registry.js";
import type { IosNativeHandle } from "../engine/index.js";
import type { SubstrateBundle, SubstrateDeps } from "../engine/registry.js";
import type { ActionSubstrate } from "./action-substrate.js";
import type { CaptureSubstrate } from "./capture-substrate.js";
import type { ElementSubstrate } from "./element-substrate.js";
import type { EmulationSubstrate } from "./emulation-substrate.js";
import type { NetworkSubstrate } from "./network-substrate.js";
import type { ScriptSubstrate } from "./script-substrate.js";
import type { SnapshotSubstrate } from "./snapshot-substrate.js";
import type { StorageSubstrate } from "./storage-substrate.js";
import type { TargetSubstrate } from "./target-substrate.js";
import { IosActionSubstrate } from "./action-substrate-ios.js";
import { IosCaptureSubstrate } from "./capture-substrate-ios.js";
import { IosElementSubstrate } from "./element-substrate-ios.js";
import { IosEmulationSubstrate } from "./emulation-substrate-ios.js";
import { IosScriptSubstrate } from "./script-substrate-ios.js";
import { IosSnapshotSubstrate } from "./snapshot-substrate-ios.js";
import { IosTargetSubstrate } from "./target-substrate-ios.js";
import { NoProtocolNetworkSubstrate } from "./network-substrate-none.js";
import { iosStorageSubstrate } from "./storage-substrate-ios.js";

const NO_NETWORK =
  "there is no protocol-level tap on a native app without a system proxy or a VPN profile, and " +
  "installing either is the operator's decision — browxai never makes it on their behalf.";

export function iosSubstrateBundle(deps: SubstrateDeps): SubstrateBundle {
  // `BrowserSession.native()` is one member serving both native engines, so the
  // engine's own bundle narrows it to the handle that engine built. Same shape as
  // the Safari bundle's `e.session.safari!()`.
  const handleOf = (e: SessionEntry): IosNativeHandle => e.session.native!() as IosNativeHandle;
  // One element substrate per session, shared by the verify family and by every
  // action verb. Sharing it is what makes "re-resolve before dispatch" a single
  // code path rather than two that can drift.
  const elementsFor = (e: SessionEntry): ElementSubstrate =>
    new IosElementSubstrate(handleOf(e), e.refs);
  return {
    actions: (e: SessionEntry): ActionSubstrate =>
      new IosActionSubstrate(handleOf(e), elementsFor(e)),
    element: elementsFor,
    snapshot: (e: SessionEntry): SnapshotSubstrate => new IosSnapshotSubstrate(handleOf(e)),
    capture: (e: SessionEntry): CaptureSubstrate => new IosCaptureSubstrate(handleOf(e), deps.save),
    target: (e: SessionEntry): TargetSubstrate => new IosTargetSubstrate(handleOf(e)),
    network: (): NetworkSubstrate => new NoProtocolNetworkSubstrate("ios-app", NO_NETWORK),
    storage: (): StorageSubstrate => iosStorageSubstrate(),
    script: (): ScriptSubstrate => new IosScriptSubstrate(),
    emulation: (): EmulationSubstrate => new IosEmulationSubstrate(),
  };
}
