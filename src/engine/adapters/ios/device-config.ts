// The operator's settings for the ios-app engine's physical-device target (RFC
// 0014 §1 and §6): which target the process drives, and which phones and apps the
// operator allowed. All of it is read from the server's environment. None of it is
// a config-store key, so `set_config` and a saved config layer cannot widen it.
//
// A device session refuses in this build. `refuseDeviceSession` is the one place
// that says so, and it runs before anything calls simctl or devicectl.

/** Which kind of iOS device the process drives. One per server process. */
export type IosTarget = "simulator" | "device";

const TARGETS: readonly IosTarget[] = ["simulator", "device"];

/** Read `BROWX_IOS_TARGET`. Unset or empty means `simulator`. Any other value
 *  throws: a mistyped target must not fall back to a sandbox or to a phone. */
export function iosTargetFrom(env: NodeJS.ProcessEnv): IosTarget {
  const raw = env.BROWX_IOS_TARGET?.trim() ?? "";
  if (raw === "") return "simulator";
  if ((TARGETS as readonly string[]).includes(raw)) return raw as IosTarget;
  throw new Error(
    `ios-target-invalid: BROWX_IOS_TARGET is "${raw}". It takes \`simulator\` (the default) ` +
      "or `device`.",
  );
}

/** A comma-separated list of exact ids: entries trimmed, empties dropped, duplicates removed. */
export function parseIdList(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** `BROWX_IOS_DEVICE_ALLOWLIST`: CoreDevice identifiers or hardware UDIDs. */
export function deviceAllowlistFrom(env: NodeJS.ProcessEnv): string[] {
  return parseIdList(env.BROWX_IOS_DEVICE_ALLOWLIST);
}

/** `BROWX_IOS_DEVICE_APPS`: exact bundle ids. No wildcard and no prefix. */
export function deviceAppsFrom(env: NodeJS.ProcessEnv): string[] {
  return parseIdList(env.BROWX_IOS_DEVICE_APPS);
}

/** The two ids a phone can be allowlisted by. A device name is not one of them. */
export interface IosDeviceIds {
  identifier: string;
  udid?: string;
}

/** An exact string match on the CoreDevice identifier or the hardware UDID. */
export function isAllowlisted(device: IosDeviceIds, allowlist: readonly string[]): boolean {
  return allowlist.some((id) => id === device.identifier || id === device.udid);
}

/**
 * The allowlist entry the operator named for this process: `BROWX_IOS_DEVICE`
 * when it is on the list, or the only entry when the list has one and
 * `BROWX_IOS_DEVICE` is unset. Undefined otherwise. The engine never picks a
 * phone because it happens to be the only one connected.
 */
export function namedDeviceEntry(env: NodeJS.ProcessEnv): string | undefined {
  const allowlist = deviceAllowlistFrom(env);
  const requested = env.BROWX_IOS_DEVICE?.trim();
  if (requested) return allowlist.includes(requested) ? requested : undefined;
  return allowlist.length === 1 ? allowlist[0] : undefined;
}

/** Throw the refusal a device session gets in this build. Always throws. */
export function refuseDeviceSession(env: NodeJS.ProcessEnv): never {
  if (deviceAllowlistFrom(env).length === 0) {
    throw new Error(
      "ios-device-not-allowlisted: BROWX_IOS_TARGET is `device` and BROWX_IOS_DEVICE_ALLOWLIST " +
        "is empty. List the phone's CoreDevice identifier or hardware UDID there. A device " +
        "name never matches.",
    );
  }
  throw new Error(
    "ios-device-not-supported: BROWX_IOS_TARGET is `device`. This build lists an allowlisted " +
      "phone in `device_list` and checks it in `browxai doctor`, and cannot open a session on " +
      "it yet. Unset BROWX_IOS_TARGET to drive a simulator.",
  );
}
