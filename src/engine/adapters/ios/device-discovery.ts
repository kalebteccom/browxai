// The physical-phone half of `device_list` (RFC 0014 §2): the allowlisted iPhones
// and iPads devicectl reports, and a count of the others.
//
// With the target at `simulator` devicectl does not run and the answer is empty.
// A phone off the allowlist is a count with no identifier. No row carries a
// device name or a hardware UDID.

import {
  defaultDevicectlRunner,
  listDevicesArgs,
  parsePhysicalDevices,
  type DevicectlRunner,
  type DevicectlDevice,
} from "./devicectl.js";
import { deviceAllowlistFrom, iosTargetFrom, isAllowlisted } from "./device-config.js";

/** One allowlisted phone as `device_list` reports it. */
export interface IosDeviceRow {
  /** The CoreDevice identifier. */
  id: string;
  model: string;
  osVersion: string | null;
  pairingState: string;
  tunnelState: string;
  transport: string;
  developerMode: string;
}

export interface IosDeviceListing {
  iosDevices: IosDeviceRow[];
  /** Connected iPhones and iPads that are not on the allowlist. */
  iosDevicesNotAllowed: number;
}

/** The fields a caller may see. The hardware UDID stays behind. */
export function toIosDeviceRow(d: DevicectlDevice): IosDeviceRow {
  return {
    id: d.identifier,
    model: d.model,
    osVersion: d.osVersion ?? null,
    pairingState: d.pairingState,
    tunnelState: d.tunnelState,
    transport: d.transport,
    developerMode: d.developerMode,
  };
}

/** Split parsed devices by the allowlist. */
export function partitionByAllowlist(
  devices: readonly DevicectlDevice[],
  allowlist: readonly string[],
): { allowed: DevicectlDevice[]; notAllowed: number } {
  const allowed = devices.filter((d) => isAllowlisted(d, allowlist));
  return { allowed, notAllowed: devices.length - allowed.length };
}

/**
 * The phones `device_list` reports. Throws only on an invalid `BROWX_IOS_TARGET`.
 * A devicectl that is absent or fails gives an empty answer, the way an absent
 * simctl gives an empty simulator list; `browxai doctor` names the cause.
 */
export async function listIosDevices(
  env: NodeJS.ProcessEnv,
  run: DevicectlRunner = defaultDevicectlRunner,
): Promise<IosDeviceListing> {
  if (iosTargetFrom(env) !== "device") return { iosDevices: [], iosDevicesNotAllowed: 0 };
  let devices: DevicectlDevice[];
  try {
    devices = parsePhysicalDevices(await run(listDevicesArgs()));
  } catch {
    devices = [];
  }
  const { allowed, notAllowed } = partitionByAllowlist(devices, deviceAllowlistFrom(env));
  return { iosDevices: allowed.map(toIosDeviceRow), iosDevicesNotAllowed: notAllowed };
}
