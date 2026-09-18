// Android-app engine registration (RFC 0008) — one of the two native engines,
// alongside `ios-app`.
//
// It is a `registerEngine(...)` call like every other and it required no edit to
// any session factory, to `session-registry.ts` or to `host-build.ts`, which is
// the open-closed claim `ocp-engine-contract` exists to prove. What it did require
// was RFC 0009: an engine with no `Page`, no DOM, no URL and no `Locator` can
// only work once `TargetSubstrate`, `ElementSubstrate` and the capture widening
// exist, and they do.
//
// ATTACH-ONLY, LIKE `android`. A session leases a device that is already up;
// `device_boot` starts an emulator and is its own tool. Folding a 30-90 second
// cold boot into `open_session` would make session creation a call that can fail
// six ways and can take a minute and a half.
//
// ONE UiAutomation OWNER PER DEVICE (RFC 0008, Honest limits). A `uiautomator
// dump` cannot be shared: a second driver, an Espresso run or an accessibility
// service holding the connection makes every dump fail. So a serial is LEASED,
// and a second session naming the same serial gets a structured refusal naming
// the holder rather than two sessions quietly corrupting each other's reads.

import type { BrowserSession, SessionOptions } from "../../session/types.js";
import { log } from "../../util/logging.js";
import { registerEngine } from "../registry.js";
import { capabilitiesFor } from "../capabilities.js";
import { androidAppSubstrateBundle } from "../../page/substrate-bundle-android-app.js";
import { buildNativeHandle, buildNativeSession } from "../../session/native-session.js";
import { AndroidDevice, defaultDeviceIO, NativeDeviceError } from "./android-app/device.js";
import { AndroidEmulatorAdapter } from "./android-app/emulator.js";

/** serial → the session id holding it. In-process, because a device lease is
 *  only meaningful within one server: two browxai processes on one machine is a
 *  configuration the operator chose and adb itself is the arbiter there. Mirrors
 *  the RFC 0005 attach-pool lease, keyed on a serial instead of a target id. */
const LEASES = new Map<string, string>();

/** The env override for which device a session leases, matching the shipped
 *  `BROWX_ANDROID_SERIAL` the `android` engine already reads. */
const SERIAL_ENV = "BROWX_ANDROID_APP_SERIAL";

/** Pick the device this session leases: the explicit env serial if set, else the
 *  single ready device. Several ready devices with no serial named is an
 *  AMBIGUITY and refuses — silently picking one is how a session ends up driving
 *  the wrong phone. */
async function pickSerial(): Promise<string> {
  const requested = process.env[SERIAL_ENV]?.trim();
  const devices = (await new AndroidEmulatorAdapter().devices()).filter(
    (d) => d.state === "device",
  );
  if (requested) {
    if (devices.some((d) => d.serial === requested)) return requested;
    throw new NativeDeviceError(
      "native-device-not-found",
      `${SERIAL_ENV} names "${requested}", which is not a ready device. Ready now: ` +
        `${devices.map((d) => d.serial).join(", ") || "(none)"}. Run \`device_list\` to see ` +
        "every device and its state, or `device_boot` to start an emulator.",
    );
  }
  if (devices.length === 1) return devices[0]!.serial;
  if (devices.length === 0) {
    throw new NativeDeviceError(
      "native-device-not-found",
      "no ready Android device or emulator is attached. Run `device_list` to see what adb sees, " +
        "and `device_boot({avd})` to start an emulator.",
    );
  }
  throw new NativeDeviceError(
    "native-device-ambiguous",
    `${devices.length} ready devices are attached (${devices.map((d) => d.serial).join(", ")}). ` +
      `Set ${SERIAL_ENV} to the one this server should drive — browxai never picks a device for ` +
      "you, because driving the wrong one is indistinguishable from a broken app.",
  );
}

/** Claim the serial for this session, or refuse naming the holder. */
function lease(serial: string, sessionId: string): () => Promise<void> {
  const holder = LEASES.get(serial);
  if (holder && holder !== sessionId) {
    throw new NativeDeviceError(
      "native-device-leased",
      `device "${serial}" is already leased by session "${holder}". Only ONE UiAutomator client ` +
        "can hold a device: a second `uiautomator dump` fails for both. Close that session, or " +
        `boot a second emulator and point ${SERIAL_ENV} at it.`,
    );
  }
  LEASES.set(serial, sessionId);
  // Returns `Promise<void>` without being `async`, which is the spelling the
  // substrate-adapter rule warns about — and it is safe HERE for the reason that
  // rule turns on: the hazard is an injected accessor throwing during argument
  // evaluation, before a promise exists. There is no accessor. `Map.get` and
  // `Map.delete` over an in-process table cannot throw, so there is nothing for
  // an `async` keyword to convert into a rejection.
  return () => {
    if (LEASES.get(serial) === sessionId) LEASES.delete(serial);
    return Promise.resolve();
  };
}

async function makeAndroidAppAdapter(opts: SessionOptions): Promise<BrowserSession> {
  const mode = opts.launchMode ?? "managed";
  if (mode === "incognito") {
    throw new NativeDeviceError(
      "native-incognito-not-supported",
      "an Android app has no second browsing context to isolate into. To start from a known " +
        "state, use `app_reset`, which clears the app's data and its granted runtime permissions.",
    );
  }
  const serial = await pickSerial();
  const sessionId = opts.sessionId ?? "default";
  const release = lease(serial, sessionId);
  try {
    const device = new AndroidDevice(serial, defaultDeviceIO());
    const foreground = await device.foreground();
    log.info("session.native: android-app session ready", {
      serial,
      foreground: foreground?.packageName,
    });
    return buildNativeSession(
      buildNativeHandle(
        device,
        foreground ? { appId: foreground.packageName, activity: foreground.activity } : undefined,
        release,
      ),
    );
  } catch (err) {
    await release();
    throw err;
  }
}

registerEngine({
  kind: "android-app",
  capabilities: capabilitiesFor("android-app")!,
  // Off by default and loud-warned. The gate sits at SESSION CREATION rather than
  // per tool, so no native tool can be reached around it: this engine installs and
  // launches applications, drives an OS-level input pipeline every app on the
  // device receives, and photographs the screen, and the same code path aimed at
  // a real handset reaches the operator's phone (RFC 0008 §8).
  requiresCapability: "native-device",
  makeAdapter: makeAndroidAppAdapter,
  makeSubstrates: (deps) => androidAppSubstrateBundle(deps),
  // Nothing to wire. The Playwright engines attach console, bridge, policy,
  // download, stealth and worker subscriptions to a `BrowserContext`; Safari
  // attaches its BiDi console bridge. A native session has none of those seams
  // yet — the device log (logcat) reaches the archive through `EventSubstrate` at
  // RFC 0009 P4, which RFC 0008 P3 depends on. An empty post-wire is the honest
  // state, and it is what the synthetic engine does too.
  postWire: () => {},
});

/** Test seam: drop every lease. A leaked lease across test files would make the
 *  second file's session refuse for a holder that no longer exists. */
export function resetNativeDeviceLeases(): void {
  LEASES.clear();
}
