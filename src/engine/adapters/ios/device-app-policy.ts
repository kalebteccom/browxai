// Which apps a phone session may launch, install or terminate (RFC 0014 G2, G3,
// G4). A pure decision over the app allowlist, so every rule tests without a
// phone.
//
//   on the list, not `com.apple.`      allow
//   on the list, `com.apple.`          launch and install need a person; terminate is allowed
//   off the list, `com.apple.`         refuse, `ios-device-system-app`
//   off the list, anything else        launch and install need a person; terminate refuses
//
// "Needs a person" is the `native_device_app` confirm hook. The engine cannot ask
// anyone, so it refuses such a call unless the tool layer recorded an approval
// for it first.

import { IosDeviceError } from "./device-errors.js";
import { isSystemApp, onAppList } from "./device-settings.js";

export type AppVerb = "launch" | "install" | "terminate";

export type AppVerdict =
  | { kind: "allow"; appId: string }
  | { kind: "confirm"; appId: string; why: string }
  | { kind: "refuse"; appId: string; error: IosDeviceError };

export function appVerdict(verb: AppVerb, appId: string, apps: readonly string[]): AppVerdict {
  const listed = onAppList(apps, appId);
  const system = isSystemApp(appId);
  if (listed && !system) return { kind: "allow", appId };
  if (listed && verb === "terminate") return { kind: "allow", appId };
  if (listed) {
    return { kind: "confirm", appId, why: "an Apple system app on BROWX_IOS_DEVICE_APPS" };
  }
  if (system) {
    return {
      kind: "refuse",
      appId,
      error: new IosDeviceError(
        "ios-device-system-app",
        `"${appId}" is an Apple system app and is not on BROWX_IOS_DEVICE_APPS, so it is ` +
          `refused for ${verb} on a phone. The operator can list it there exactly, and a launch ` +
          "still asks a person every time.",
      ),
    };
  }
  if (verb === "terminate") {
    return {
      kind: "refuse",
      appId,
      error: new IosDeviceError(
        "ios-device-app-not-allowed",
        `"${appId}" is not on BROWX_IOS_DEVICE_APPS, and a phone session only stops apps on it.`,
      ),
    };
  }
  return { kind: "confirm", appId, why: "not on BROWX_IOS_DEVICE_APPS" };
}

/** The refusal for a `confirm` verdict nobody approved. */
export function unapprovedError(verb: AppVerb, appId: string, why: string): IosDeviceError {
  return new IosDeviceError(
    "ios-device-app-not-allowed",
    `"${appId}" is ${why}, so ${verb} on a phone needs a person's approval through the ` +
      "`native_device_app` confirm hook, and none was given. Ask the operator to list it in " +
      "BROWX_IOS_DEVICE_APPS, or to approve the prompt.",
  );
}
