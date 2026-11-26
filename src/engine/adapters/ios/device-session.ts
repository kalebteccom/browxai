// Open an ios-app session on the allowlisted phone (RFC 0014 §3). The order is
// the RFC's, and each step refuses before the next one can reach the phone:
//
//   1. read the settings and check both allowlists        (device-settings.ts)
//   2. devicectl list devices; pairing, tunnel, Developer Mode
//   3. take the lease                                      (device-lease.ts)
//   4. GET /status and binding checks 1 and 2              (device-binding.ts)
//   5. refuse a locked phone; never unlock it (G9)
//   6. the optional install, through the app allowlist
//   7. POST /session, which launches the app under test
//   8. the app under test is frontmost, and binding check 3
//
// A refusal after step 3 deletes any WebDriverAgent session and releases the
// lease. Nothing here boots, unlocks or starts WebDriverAgent.

import type { IosNativeHandle } from "../../native-types.js";
import { log } from "../../../util/logging.js";
import { IosDeviceError } from "./device-errors.js";
import { deviceSettingsFrom, type IosDeviceSettings } from "./device-settings.js";
import { isAllowlisted } from "./device-config.js";
import { leaseIosDevice } from "./device-lease.js";
import { checkPidBinding, checkStatusBinding, wdaBuildOf } from "./device-binding.js";
import { IosPhysicalDevice } from "./device.js";
import { IosDeviceDriver } from "./device-driver.js";
import { IosXcuiDriver } from "./xcui-driver.js";
import { IosLifecycle } from "./lifecycle.js";
import { defaultHttp, WdaClient } from "./wda-client.js";
import type { PlutilRunner } from "./bundle-id.js";
import {
  defaultDevicectlRunner,
  listDevicesArgs,
  listProcessesArgs,
  parsePhysicalDevices,
  parseProcesses,
  type DevicectlDevice,
  type DevicectlRunner,
} from "./devicectl.js";

export interface IosDeviceSessionDeps {
  env: NodeJS.ProcessEnv;
  /** The session the lease is held for. */
  sessionId: string;
  makeClient?: (baseUrl: string) => WdaClient;
  devicectl?: DevicectlRunner;
  plutil?: PlutilRunner;
}

/** The default WebDriverAgent client for a phone: its unreachable error names
 *  the phone's causes. */
function phoneClient(baseUrl: string): WdaClient {
  return new WdaClient(baseUrl, defaultHttp(30_000, "device"));
}

/** Step 2: the allowlisted phone as devicectl lists it, ready to drive. */
export async function findReadyPhone(
  entry: string,
  devicectl: DevicectlRunner,
): Promise<DevicectlDevice> {
  const devices = parsePhysicalDevices(await devicectl(listDevicesArgs()));
  const phone = devices.find((d) => isAllowlisted(d, [entry]));
  if (!phone) {
    throw new IosDeviceError(
      "ios-device-disconnected",
      "devicectl does not list the allowlisted phone. Connect it by cable or pair it for " +
        "network use in Xcode, Devices and Simulators, and keep its screen on.",
    );
  }
  if (phone.pairingState !== "paired") {
    throw new IosDeviceError(
      "ios-device-not-paired",
      `the phone's pairing state is ${phone.pairingState}. Tap Trust on the phone when it asks.`,
    );
  }
  if (phone.tunnelState !== "connected") {
    throw new IosDeviceError(
      "ios-device-disconnected",
      `the phone's tunnel is ${phone.tunnelState}. Wake it and keep it on the Mac's network, or ` +
        "connect it by cable.",
    );
  }
  if (phone.developerMode !== "enabled") {
    throw new IosDeviceError(
      "ios-device-developer-mode-off",
      "Developer Mode is not enabled on the phone. Turn it on in Settings, Privacy & Security, " +
        "Developer Mode, and restart the phone.",
    );
  }
  return phone;
}

/** Steps 4 and 5. Returns the WebDriverAgent build for later refusals. */
async function checkWda(wda: WdaClient, phone: DevicectlDevice): Promise<string | undefined> {
  const status = await wda.status();
  checkStatusBinding(status, phone.osVersion);
  if (await wda.locked()) {
    throw new IosDeviceError(
      "ios-device-locked",
      "the phone is locked. Unlock it by hand and set Auto-Lock to Never for the run. browxai " +
        "holds no passcode and never unlocks a phone.",
    );
  }
  return wdaBuildOf(status);
}

/** Step 8: the app under test is in front, on this phone. */
async function checkLaunched(
  wda: WdaClient,
  phone: DevicectlDevice,
  appId: string,
  devicectl: DevicectlRunner,
): Promise<void> {
  const front = await wda.activeAppInfo();
  if (front.bundleId !== appId) {
    throw new IosDeviceError(
      "ios-device-launch-not-frontmost",
      `WebDriverAgent opened the session and "${appId}" is not the frontmost app. Unlock the ` +
        "phone, dismiss any alert, and open the session again.",
    );
  }
  const processes = parseProcesses(await devicectl(listProcessesArgs(phone.identifier)));
  checkPidBinding(front, appId, processes);
}

interface Opened {
  settings: IosDeviceSettings;
  phone: DevicectlDevice;
  wda: WdaClient;
  devicectl: DevicectlRunner;
  plutil?: PlutilRunner;
}

/** Steps 4 to 8, and the handle. */
async function attach(o: Opened, release: () => void): Promise<IosNativeHandle> {
  const { settings, phone, wda, devicectl } = o;
  const wdaBuild = await checkWda(wda, phone);
  const host = new IosPhysicalDevice({
    identifier: phone.identifier,
    wda,
    apps: settings.apps,
    devicectl,
    ...(o.plutil ? { plutil: o.plutil } : {}),
    ...(wdaBuild ? { wdaBuild } : {}),
  });
  if (settings.appPath) await host.install(settings.appPath);
  await wda.newSession(settings.appId);
  await checkLaunched(wda, phone, settings.appId, devicectl);
  log.info("session.managed: ios-app session ready on a phone", {
    model: phone.model,
    ios: phone.osVersion,
    transport: phone.transport,
    appId: settings.appId,
  });
  const driver = new IosDeviceDriver(new IosXcuiDriver(wda, host));
  return {
    engine: "ios-app",
    platform: "ios",
    deviceId: phone.identifier,
    app: { appId: settings.appId },
    driver,
    lifecycle: new IosLifecycle(host, driver, "device"),
    close: async () => {
      // The app under test and the WebDriverAgent session are what this session
      // owns (G14). The runner, and every other app, are the operator's.
      await host.terminateOnClose(settings.appId);
      await driver.close().catch(() => undefined);
      release();
    },
  };
}

export async function launchIosDeviceSession(deps: IosDeviceSessionDeps): Promise<IosNativeHandle> {
  const settings = deviceSettingsFrom(deps.env);
  const devicectl = deps.devicectl ?? defaultDevicectlRunner;
  const phone = await findReadyPhone(settings.entry, devicectl);
  const release = leaseIosDevice(phone.identifier, deps.sessionId);
  const wda = (deps.makeClient ?? phoneClient)(settings.wdaUrl);
  try {
    return await attach(
      { settings, phone, wda, devicectl, ...(deps.plutil ? { plutil: deps.plutil } : {}) },
      release,
    );
  } catch (err) {
    await wda.deleteSession().catch(() => undefined);
    release();
    throw err;
  }
}
