// The ios-app engine registration — one of RFC 0008's two native-app engines,
// alongside `android-app`. The `safari.engine.ts` template: one `registerEngine(...)` call declaring the
// capability row, the launch function, the substrate bundle and the post-wire
// step, in a module nothing else edits.
//
// WHAT A LAUNCH DOES on the simulator target, in order: resolve a simulator, boot it and wait for the
// boot to finish, install the `.app` when one was named, launch the app, then
// attach an XCUITest session through WebDriverAgent. The first four are `simctl`
// and need nothing beyond Xcode; the fifth needs a WebDriverAgent the operator
// runs, and a launch REFUSES when it is not there.
//
// REFUSING IS THE POINT. The engine declares the `snapshot` and `element`
// sub-interfaces, and `sub-interface-conformance` holds a declared sub-interface
// to having a working implementation. Opening a session with no XCUITest driver
// would leave `snapshot` answering with an empty tree — a plausible value for a
// question the session cannot answer, which is the failure mode that whole gate
// exists to catch. So the failure lands at session creation, once, naming the
// fix, rather than as a degraded read per tool call.
//
// With BROWX_IOS_TARGET=device the launch is `launchIosDeviceSession` instead
// (RFC 0014): an allowlisted phone, reached through devicectl and a WebDriverAgent
// the operator runs on it, with the phone's guard rails.
//
// The device and the app are read from the environment, mirroring the android
// engine's `BROWX_ANDROID_APP_SERIAL`. RFC 0008 §2 proposes them as an
// `open_session({native:{…}})` option instead; that is a wire-schema change both
// native engines want to make the same way, and neither has made it yet.

import type { IosNativeHandle } from "../native-types.js";
import type { BrowserSession, SessionOptions } from "../../session/types.js";
import { log } from "../../util/logging.js";
import { registerEngine } from "../registry.js";
import { capabilitiesFor } from "../capabilities.js";
import { buildIosSession } from "../../session/ios-session.js";
import { iosSubstrateBundle } from "../../page/substrate-bundle-ios.js";
import { IosSimulator, resolveSimulator } from "./ios/simulator.js";
import { IosXcuiDriver } from "./ios/xcui-driver.js";
import { IosLifecycle } from "./ios/lifecycle.js";
import { DEFAULT_WDA_URL, WdaClient } from "./ios/wda-client.js";
import { iosTargetFrom } from "./ios/device-config.js";
import { launchIosDeviceSession } from "./ios/device-session.js";
import type { DevicectlRunner } from "./ios/devicectl.js";
import type { PlutilRunner } from "./ios/bundle-id.js";

/** The environment the operator configures an ios-app session with. */
export interface IosLaunchEnv {
  /** A simulator udid or an exact device name. Omitted ⇒ a booted simulator,
   *  else the newest installed runtime. */
  device?: string;
  /** Bundle id of the app under test. */
  appId?: string;
  /** Path to a `.app` bundle to install before launching. Omitted ⇒ the app is
   *  assumed to be installed already. */
  appPath?: string;
  /** Where WebDriverAgent is listening. */
  wdaUrl?: string;
}

export function iosEnvFrom(env: NodeJS.ProcessEnv): IosLaunchEnv {
  return {
    ...(env.BROWX_IOS_DEVICE ? { device: env.BROWX_IOS_DEVICE } : {}),
    ...(env.BROWX_IOS_APP_ID ? { appId: env.BROWX_IOS_APP_ID } : {}),
    ...(env.BROWX_IOS_APP_PATH ? { appPath: env.BROWX_IOS_APP_PATH } : {}),
    ...(env.BROWX_IOS_WDA_URL ? { wdaUrl: env.BROWX_IOS_WDA_URL } : {}),
  };
}

/** Injectable seams, so the launch sequence tests without Xcode. */
export interface IosAdapterDeps {
  env?: NodeJS.ProcessEnv;
  makeClient?: (baseUrl: string) => WdaClient;
  /** The session a phone lease is held for. */
  sessionId?: string;
  devicectl?: DevicectlRunner;
  plutil?: PlutilRunner;
}

/** Boot, install, launch, attach — and hand back the native session handle. */
export async function launchIosSession(deps: IosAdapterDeps = {}): Promise<IosNativeHandle> {
  const rawEnv = deps.env ?? process.env;
  // The target decides everything after it, so it is read first. A device target
  // never reaches simctl (RFC 0014 §1).
  if (iosTargetFrom(rawEnv) === "device") {
    return launchIosDeviceSession({
      env: rawEnv,
      sessionId: deps.sessionId ?? "default",
      ...(deps.makeClient ? { makeClient: deps.makeClient } : {}),
      ...(deps.devicectl ? { devicectl: deps.devicectl } : {}),
      ...(deps.plutil ? { plutil: deps.plutil } : {}),
    });
  }
  const env = iosEnvFrom(rawEnv);
  if (!env.appId) {
    throw new Error(
      "ios-app-no-bundle-id: the ios-app engine drives one application, named by its bundle id. " +
        "Set BROWX_IOS_APP_ID (e.g. `com.acme.checkout`), and BROWX_IOS_APP_PATH as well when the " +
        "app is not installed on the simulator yet.",
    );
  }
  const device = await resolveSimulator(env.device);
  const sim = new IosSimulator(device.id);
  await sim.boot();
  if (env.appPath) await sim.install(env.appPath);
  const app = await sim.launch(env.appId);
  const wda = (deps.makeClient ?? ((baseUrl) => new WdaClient(baseUrl)))(
    env.wdaUrl ?? DEFAULT_WDA_URL,
  );
  // `status` first: it is the one endpoint needing no session, so an absent
  // WebDriverAgent surfaces as `WdaUnreachableError` before an app-scoped session
  // is half-created.
  await wda.status();
  await wda.newSession(env.appId);
  log.info("session.managed: ios-app session ready", {
    device: device.id,
    runtime: device.runtime,
    appId: env.appId,
    pid: app.pid,
  });
  const driver = new IosXcuiDriver(wda, sim);
  return {
    engine: "ios-app",
    platform: "ios",
    deviceId: device.id,
    app: { appId: env.appId },
    driver,
    lifecycle: new IosLifecycle(sim, driver),
    close: async () => {
      // The XCUITest session and the app process are what this session owns. The
      // simulator is not: booting one costs tens of seconds and the operator may
      // have booted it themselves, so shutting it down would destroy state
      // outside this session's lifetime.
      await driver.close().catch(() => undefined);
      await sim.terminate(env.appId!).catch(() => undefined);
    },
  };
}

async function makeIosAdapter(opts: SessionOptions): Promise<BrowserSession> {
  const mode = opts.launchMode ?? "managed";
  if (mode === "incognito") {
    throw new Error(
      "ios-app-incognito-not-supported: incognito is a separate browser context, which is a " +
        "Playwright concept a simulator has no equivalent for. To start an app from a known " +
        "state, erase the device (`xcrun simctl erase <udid>`) or reinstall the app before " +
        "opening the session.",
    );
  }
  if (mode === "byob") {
    throw new Error(
      "ios-app-attach-not-supported: there is nothing to attach to. An XCUITest session is created " +
        "by WebDriverAgent against an application it launches; browxai cannot adopt an app the " +
        "user is already driving by hand. Open a managed session.",
    );
  }
  return buildIosSession(
    await launchIosSession(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  );
}

registerEngine({
  kind: "ios-app",
  capabilities: capabilitiesFor("ios-app")!,
  // Off by default and loud-warned. The gate sits at SESSION CREATION rather than
  // per tool, so no native tool can be reached around it: this engine installs and
  // launches applications, drives an OS-level input pipeline and photographs the
  // screen, and the same code path aimed at a real device reaches the operator's
  // phone (RFC 0008 §8).
  requiresCapability: "native-device",
  makeAdapter: makeIosAdapter,
  makeSubstrates: (deps) => iosSubstrateBundle(deps),
  // Nothing to wire. Every Playwright post-creation step (console bridge, dialog
  // and permission policies, download capture, stealth, device emulation,
  // ws-interactive, workers) is bound to a `Page` or a `BrowserContext`, and this
  // engine has neither. The device log bridge RFC 0008 §2 maps `console_read` onto
  // is a later phase; until it lands the engine declares no console source rather
  // than attaching an empty one.
  postWire: () => {},
});
