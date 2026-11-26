// The checked settings a device session opens with (RFC 0014 §4, §6). This is the
// first step of the device session order and it runs before devicectl or
// WebDriverAgent is reached, so a build with no allowlist cannot touch a phone.
//
// G1: the device allowlist is required and names one phone.
// G2: the app under test is on the app allowlist.
// G4: a `com.apple.` app is never the app under test. An operator who needs one
//     lists it exactly and launches it with `app_launch`, which asks a person.

import { isAbsolute, resolve } from "node:path";
import { IosDeviceError } from "./device-errors.js";
import { deviceAllowlistFrom, deviceAppsFrom, namedDeviceEntry } from "./device-config.js";

/** Bundle ids under this prefix are Apple's own apps (RFC 0014 G4). */
export const SYSTEM_APP_PREFIX = "com.apple.";

export function isSystemApp(bundleId: string): boolean {
  return bundleId.startsWith(SYSTEM_APP_PREFIX);
}

export interface IosDeviceSettings {
  /** The allowlist entry that names the phone: an identifier or a hardware UDID. */
  entry: string;
  /** BROWX_IOS_DEVICE_APPS. */
  apps: readonly string[];
  appId: string;
  /** An absolute host path, when the operator named a bundle to install. */
  appPath?: string;
  wdaUrl: string;
}

const LOOPBACK = new Set(["localhost", "::1", "[::1]"]);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || /^127\./.test(host);
}

/** The device entry, or the `ios-device-not-allowlisted` refusal. */
function deviceEntry(env: NodeJS.ProcessEnv): string {
  const allowlist = deviceAllowlistFrom(env);
  if (allowlist.length === 0) {
    throw new IosDeviceError(
      "ios-device-not-allowlisted",
      "BROWX_IOS_TARGET is `device` and BROWX_IOS_DEVICE_ALLOWLIST is empty. List the phone's " +
        "CoreDevice identifier or hardware UDID there. A device name never matches.",
    );
  }
  const entry = namedDeviceEntry(env);
  if (entry) return entry;
  throw new IosDeviceError(
    "ios-device-not-allowlisted",
    env.BROWX_IOS_DEVICE?.trim()
      ? "BROWX_IOS_DEVICE is not on BROWX_IOS_DEVICE_ALLOWLIST. Name an entry from the list."
      : "BROWX_IOS_DEVICE_ALLOWLIST lists more than one phone. Name one with BROWX_IOS_DEVICE.",
  );
}

/** The app under test, checked against the app allowlist. */
function appUnderTest(env: NodeJS.ProcessEnv, apps: readonly string[]): string {
  const appId = env.BROWX_IOS_APP_ID?.trim();
  if (!appId) {
    throw new IosDeviceError(
      "ios-app-no-bundle-id",
      "the ios-app engine drives one application, named by its bundle id. Set BROWX_IOS_APP_ID " +
        "and list the same id in BROWX_IOS_DEVICE_APPS.",
    );
  }
  if (isSystemApp(appId)) {
    throw new IosDeviceError(
      "ios-device-system-app",
      `"${appId}" is an Apple system app, and a session on a phone never opens on one. Open the ` +
        "session on your own app. To reach a system app, list it exactly in " +
        "BROWX_IOS_DEVICE_APPS and launch it with `app_launch`, which asks a person each time.",
    );
  }
  if (!apps.includes(appId)) {
    throw new IosDeviceError(
      "ios-device-app-not-allowed",
      `BROWX_IOS_APP_ID "${appId}" is not on BROWX_IOS_DEVICE_APPS. List it there exactly. ` +
        "No wildcard and no prefix match.",
    );
  }
  return appId;
}

/** BROWX_IOS_WDA_URL, required on a phone and never a loopback address. */
function wdaUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.BROWX_IOS_WDA_URL?.trim();
  const fix =
    "Start WebDriverAgent on the phone and set BROWX_IOS_WDA_URL to http://<phone address>:8100.";
  if (!raw) {
    throw new IosDeviceError("ios-device-wda-url", `BROWX_IOS_WDA_URL is unset. ${fix}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IosDeviceError("ios-device-wda-url", `BROWX_IOS_WDA_URL is not a URL. ${fix}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new IosDeviceError("ios-device-wda-url", `BROWX_IOS_WDA_URL is not http. ${fix}`);
  }
  if (isLoopback(url.hostname)) {
    throw new IosDeviceError(
      "ios-device-wda-url",
      "BROWX_IOS_WDA_URL points at this Mac. On a Mac a loopback address reaches a simulator's " +
        `WebDriverAgent while devicectl installs onto the phone. ${fix}`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/** Check the operator's device settings, or throw the first refusal. */
export function deviceSettingsFrom(env: NodeJS.ProcessEnv): IosDeviceSettings {
  const entry = deviceEntry(env);
  const apps = deviceAppsFrom(env);
  const appId = appUnderTest(env, apps);
  const rawPath = env.BROWX_IOS_APP_PATH?.trim();
  return {
    entry,
    apps,
    appId,
    ...(rawPath ? { appPath: isAbsolute(rawPath) ? rawPath : resolve(rawPath) } : {}),
    wdaUrl: wdaUrl(env),
  };
}
