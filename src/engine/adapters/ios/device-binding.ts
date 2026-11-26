// Tie the WebDriverAgent address to the allowlisted phone (RFC 0014 §5).
// devicectl names a phone by identifier and WebDriverAgent is only an address, so
// a wrong address could put taps on another device than the one that got the
// install. Three checks, each refusing with `ios-device-wda-mismatch`:
//
//   1. `/status` does not describe a simulator (`ios.simulatorVersion` absent).
//   2. The iOS version in `/status` (`os.version`) equals devicectl's.
//   3. After `POST /session`, the frontmost app's pid is running on the phone
//      devicectl lists, under the same bundle id when devicectl reports one.
//
// The field names are from WebDriverAgent and devicectl as remembered, and are
// unverified on Xcode 26.5 (RFC 0014 §17, items 5 and 7). Each check fails
// closed: a missing field refuses.

import { IosDeviceError } from "./device-errors.js";
import type { DeviceProcess } from "./devicectl.js";

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

function mismatch(detail: string): IosDeviceError {
  return new IosDeviceError(
    "ios-device-wda-mismatch",
    `${detail} BROWX_IOS_WDA_URL may reach a simulator or another phone, so nothing was ` +
      "installed or launched. Check the address and that the runner runs on the allowlisted phone.",
  );
}

/** `27.2.0` and `27.2` are the same release. */
function normalVersion(v: string): string {
  return v.trim().replace(/(\.0)+$/, "");
}

/** Checks 1 and 2, against WebDriverAgent's `/status` value. */
export function checkStatusBinding(status: unknown, phoneOsVersion: string | undefined): void {
  const s = obj(status);
  if (obj(s.ios).simulatorVersion !== undefined) {
    throw mismatch("WebDriverAgent's /status describes a simulator.");
  }
  const wdaOs = obj(s.os).version;
  if (typeof wdaOs !== "string" || !phoneOsVersion) {
    throw mismatch(
      "the iOS version is missing from WebDriverAgent's /status or from devicectl, so the two " +
        "cannot be compared.",
    );
  }
  if (normalVersion(wdaOs) !== normalVersion(phoneOsVersion)) {
    throw mismatch(
      `WebDriverAgent reports iOS ${wdaOs} and devicectl reports iOS ${phoneOsVersion} for the ` +
        "allowlisted phone.",
    );
  }
}

/** Check 3: the frontmost app's pid runs on the allowlisted phone. */
export function checkPidBinding(
  front: { bundleId?: string; pid?: number },
  bundleId: string,
  processes: readonly DeviceProcess[],
): void {
  if (typeof front.pid !== "number") {
    throw mismatch("WebDriverAgent reported no pid for the app under test.");
  }
  const row = processes.find((p) => p.pid === front.pid);
  if (!row || (row.bundleId !== undefined && row.bundleId !== bundleId)) {
    throw mismatch(
      "the app WebDriverAgent launched is not running on the phone devicectl lists under that pid.",
    );
  }
}

/** The WebDriverAgent build `/status` names, for refusals that mention it. */
export function wdaBuildOf(status: unknown): string | undefined {
  const build = obj(obj(status).build);
  const version = build.version;
  return typeof version === "string" && version ? `build ${version}` : undefined;
}
