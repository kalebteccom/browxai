// The native session handle — RFC 0008 §1 item 4, which RFC 0009 left standing:
// `native?(): NativeSessionHandle` on `BrowserSession`, mirroring `safari?()`.
//
// The pattern is the one RFC 0009 settled on for every engine: no engine promises
// a handle it lacks, and each reaches its own concrete world through an optional,
// engine-named accessor. A native substrate reads `e.session.native!()` exactly
// as the Safari bundle reads `e.session.safari!()`.
//
// `platform` is on the handle rather than derived from the engine kind because
// P4's `ios-app` shares this shape: a simulator handle carries the same screen
// and the same lifecycle verbs over a different transport, and the substrates
// above it should not need a second switch to find that out.

import type { NativeScreen } from "../../../page/native-screen.js";
import type { AndroidDevice } from "./device.js";

/** The app under test, as named at session open. */
export interface NativeAppTarget {
  /** The package id, e.g. `com.acme.app`. */
  appId: string;
  /** The activity the last launch resolved to, when one has been launched. */
  activity?: string;
}

/** The native-engine escape hatch. Present ONLY on a native session. */
export interface NativeSessionHandle {
  /** Which native platform this is. `ios-app` (RFC 0008 P4) reuses the shape. */
  readonly platform: "android";
  /** The device or emulator this session is leased to. */
  readonly device: AndroidDevice;
  /** The shared view-hierarchy source. Every substrate reads through it, so one
   *  action costs one `uiautomator dump` and not one per substrate. */
  readonly screen: NativeScreen;
  /** The app under test. Mutable across the session because `app_launch` can
   *  point a session at a different app without reopening it. */
  app: NativeAppTarget | undefined;
  close(): Promise<void>;
}
