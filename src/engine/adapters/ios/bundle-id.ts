// Read the bundle id out of a `.app` bundle before it is installed on a phone
// (RFC 0014 §6). The app allowlist is checked against this id, so an install of a
// bundle whose id cannot be read refuses.
//
// `/usr/bin/plutil -extract CFBundleIdentifier raw -o - <app>/Info.plist` prints
// the value on stdout. No shell, and the path is its own argv element. The
// command line is unverified on a Mac (RFC 0014 §17, item 10).

import { execFile } from "node:child_process";
import { join } from "node:path";
import { IosDeviceError } from "./device-errors.js";

/** Runs `/usr/bin/plutil` with an argument list and resolves its stdout. */
export type PlutilRunner = (args: readonly string[]) => Promise<string>;

export const defaultPlutilRunner: PlutilRunner = (args) =>
  new Promise<string>((resolve, reject) => {
    execFile("/usr/bin/plutil", [...args], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`plutil failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });

export function bundleIdArgs(appPath: string): readonly string[] {
  return ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(appPath, "Info.plist")];
}

/** A reverse-DNS bundle id. Anything else is treated as unreadable. */
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** The bundle's `CFBundleIdentifier`, or `ios-device-bundle-id-unreadable`. */
export async function readBundleId(appPath: string, run: PlutilRunner): Promise<string> {
  let out: string;
  try {
    out = (await run(bundleIdArgs(appPath))).trim();
  } catch (err) {
    throw new IosDeviceError(
      "ios-device-bundle-id-unreadable",
      `could not read CFBundleIdentifier from the bundle's Info.plist (${err instanceof Error ? err.message : String(err)}). ` +
        "A phone install needs the bundle id to check it against BROWX_IOS_DEVICE_APPS.",
    );
  }
  if (!BUNDLE_ID.test(out)) {
    throw new IosDeviceError(
      "ios-device-bundle-id-unreadable",
      "the bundle's Info.plist has no readable CFBundleIdentifier. A phone install needs it to " +
        "check the app against BROWX_IOS_DEVICE_APPS.",
    );
  }
  return out;
}
