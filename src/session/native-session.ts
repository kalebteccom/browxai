// The `android-app` BrowserSession constructor — the native counterpart of
// `buildSafariSession`.
//
// It OMITS `page`, `cdp` and `targetId`. That omission is the contract
// `port-conformance.test.ts` enforces: an engine declares page-availability as
// `caps.subInterfaces.has("page")` and its session shape must agree, so a session
// that declares no `page` and supplies the handle anyway is a second, disagreeing
// oracle. Safari's `page()` used to throw `safari-no-playwright-page` and the
// whole suite stayed green; the fix was to delete the member, and this session
// never grows one.
//
// What it supplies instead is `native()`, carrying the device lease, the shared
// view-hierarchy source and the app under test.

import type { AndroidDevice } from "../engine/adapters/android-app/device.js";
import type { AndroidNativeHandle } from "../engine/adapters/android-app/handle.js";
import { AndroidLifecycle } from "../engine/adapters/android-app/lifecycle.js";
import type { NativeAppTarget } from "../engine/native-types.js";
import { NativeScreen } from "../page/native-screen.js";
import type { BrowserSession } from "./types.js";

/** Build the native session handle for one device lease. */
export function buildNativeHandle(
  device: AndroidDevice,
  app: NativeAppTarget | undefined,
  release: () => Promise<void>,
): AndroidNativeHandle {
  const handle: AndroidNativeHandle = {
    engine: "android-app",
    platform: "android",
    deviceId: device.serial,
    device,
    lifecycle: new AndroidLifecycle(device),
    // One screen per session, shared by all five substrates, so one action costs
    // one `uiautomator dump` rather than one per substrate that wants to look.
    screen: new NativeScreen({ dump: () => device.dumpHierarchy() }),
    app,
    close: release,
  };
  return handle;
}

/** The `android-app` session. `mode` is `"managed"` because browxai owns the
 *  lease on the device for the session's lifetime — the same sense in which a
 *  managed browser session owns its profile. It does NOT mean browxai launched
 *  the emulator: `device_boot` does that, as its own tool, and closing a session
 *  never shuts a device down. */
export function buildNativeSession(handle: AndroidNativeHandle): BrowserSession {
  return {
    mode: "managed",
    // The device outlives the session. `close()` releases the lease; it does not
    // power anything off, because an agent that opened a session against an
    // emulator the operator was already using must not take it away on exit.
    ownsBrowser: false,
    engine: "android-app",
    native: () => handle,
    close: () => handle.close(),
  };
}
