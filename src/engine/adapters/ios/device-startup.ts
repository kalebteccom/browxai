// The second line of the `native-device` startup warning when the ios-app target
// is a real phone (RFC 0014 G13): the model, the iOS version and the count of
// allowlisted apps. Never a device name, a UDID or an address.
//
// It runs devicectl only when the target is `device` and an allowlist entry
// names a phone, and it never fails startup.

import { log } from "../../../util/logging.js";
import { deviceAppsFrom, iosTargetFrom, isAllowlisted, namedDeviceEntry } from "./device-config.js";
import {
  defaultDevicectlRunner,
  listDevicesArgs,
  parsePhysicalDevices,
  type DevicectlDevice,
  type DevicectlRunner,
} from "./devicectl.js";

async function namedPhone(
  env: NodeJS.ProcessEnv,
  run: DevicectlRunner,
): Promise<DevicectlDevice | undefined> {
  const entry = namedDeviceEntry(env);
  if (!entry) return undefined;
  try {
    return parsePhysicalDevices(await run(listDevicesArgs())).find((d) =>
      isAllowlisted(d, [entry]),
    );
  } catch {
    return undefined;
  }
}

/** The warning line, or undefined when the target is not a phone. */
export async function iosDeviceTargetWarning(
  env: NodeJS.ProcessEnv,
  run: DevicectlRunner = defaultDevicectlRunner,
): Promise<string | undefined> {
  try {
    if (iosTargetFrom(env) !== "device") return undefined;
  } catch {
    return undefined;
  }
  const apps = deviceAppsFrom(env).length;
  const phone = await namedPhone(env, run);
  const what = phone
    ? `${phone.model}, iOS ${phone.osVersion ?? "unknown"}`
    : "no allowlisted phone devicectl lists right now";
  return (
    `native-device targets a real phone (BROWX_IOS_TARGET=device): ${what}, ` +
    `${apps} allowlisted ${apps === 1 ? "app" : "apps"}. ios-app sessions install, launch and ` +
    "tap apps on that phone. Unset BROWX_IOS_TARGET to drive a simulator."
  );
}

/** Log the line when there is one. Fire and forget: startup does not wait on devicectl. */
export function warnIosDeviceTarget(env: NodeJS.ProcessEnv = process.env): void {
  void iosDeviceTargetWarning(env)
    .then((line) => {
      if (line) log.warn(line);
    })
    .catch(() => undefined);
}
