import { describe, expect, it } from "vitest";
import { iosDeviceTargetWarning } from "./device-startup.js";
import {
  DEVICECTL_LIST,
  DEVICE_NAMES,
  DEVICE_UDIDS,
  PHONE_UDID,
} from "./__fixtures__/devicectl-devices.js";

const never = (): Promise<unknown> => Promise.reject(new Error("devicectl must not run"));

describe("iosDeviceTargetWarning (G13)", () => {
  it("says nothing, and runs nothing, when the target is not a phone", async () => {
    await expect(iosDeviceTargetWarning({}, never)).resolves.toBeUndefined();
    await expect(iosDeviceTargetWarning({ BROWX_IOS_TARGET: "x" }, never)).resolves.toBeUndefined();
  });

  it("names the model, the iOS version and the app count, never the phone's name or UDID", async () => {
    const line = await iosDeviceTargetWarning(
      {
        BROWX_IOS_TARGET: "device",
        BROWX_IOS_DEVICE_ALLOWLIST: PHONE_UDID,
        BROWX_IOS_DEVICE_APPS: "com.acme.a,com.acme.b",
      },
      () => Promise.resolve(DEVICECTL_LIST),
    );
    expect(line).toContain("iPhone 17e, iOS 27.2, 2 allowlisted apps");
    for (const secret of [...DEVICE_NAMES, ...DEVICE_UDIDS]) expect(line).not.toContain(secret);
  });

  it("skips devicectl with no allowlist, and survives a failing one", async () => {
    const none = await iosDeviceTargetWarning({ BROWX_IOS_TARGET: "device" }, never);
    expect(none).toContain("no allowlisted phone");
    const failing = await iosDeviceTargetWarning(
      { BROWX_IOS_TARGET: "device", BROWX_IOS_DEVICE_ALLOWLIST: "a" },
      never,
    );
    expect(failing).toContain("no allowlisted phone");
  });
});
