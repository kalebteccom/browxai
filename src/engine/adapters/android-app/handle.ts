// The android-app session handle — the ADAPTER-INTERNAL extension of the shared
// `NativeSessionHandle` (`src/engine/native-types.ts`).
//
// The shared handle carries what both native engines genuinely have: the
// platform, the device the session is leased to, the app under test and the
// app-lifecycle seam. What it does NOT carry is a transport member, because the
// two engines' transports are not two spellings of one thing — iOS reads its
// screen through a `NativeDriver` over WebDriverAgent, and this engine reads its
// screen through a shared `NativeScreen` over `uiautomator dump`. So each adapter
// extends the shared shape with its own, and its own substrate bundle is the only
// reader of the extension.
//
// `screen` is shared across the bundle on purpose: every substrate reads through
// it, so one action costs one `uiautomator dump` and not one per substrate.

import type { NativeSessionHandle } from "../../native-types.js";
import type { NativeScreen } from "../../../page/native-screen.js";
import type { AndroidDevice } from "./device.js";

/** The android-app engine's session handle. */
export interface AndroidNativeHandle extends NativeSessionHandle {
  readonly platform: "android";
  /** The device or emulator this session is leased to. */
  readonly device: AndroidDevice;
  /** The shared view-hierarchy source. */
  readonly screen: NativeScreen;
}
