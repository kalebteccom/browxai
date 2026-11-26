import { describe, expect, it } from "vitest";
import { launchIosSession } from "./ios-app.engine.js";

// A device target that fails its settings refuses before simctl, devicectl or
// WebDriverAgent is reached. `makeClient` throws if anything gets that far.
const unreachable = (): never => {
  throw new Error("the launch went past the target check");
};

describe("launchIosSession with BROWX_IOS_TARGET=device", () => {
  it("refuses with no allowlist", async () => {
    await expect(
      launchIosSession({
        env: { BROWX_IOS_TARGET: "device", BROWX_IOS_APP_ID: "com.acme.app" },
        makeClient: unreachable,
      }),
    ).rejects.toThrow(/^ios-device-not-allowlisted:/);
  });

  it("refuses an app under test that is off the app allowlist, before devicectl", async () => {
    await expect(
      launchIosSession({
        env: {
          BROWX_IOS_TARGET: "device",
          BROWX_IOS_DEVICE_ALLOWLIST: "11111111-AAAA-4AAA-8AAA-111111111111",
          BROWX_IOS_APP_ID: "com.acme.app",
        },
        makeClient: unreachable,
        devicectl: unreachable,
      }),
    ).rejects.toThrow(/^ios-device-app-not-allowed:/);
  });

  it("takes the device path, never simctl, once the settings pass", async () => {
    const seen: string[] = [];
    await expect(
      launchIosSession({
        env: {
          BROWX_IOS_TARGET: "device",
          BROWX_IOS_DEVICE_ALLOWLIST: "11111111-AAAA-4AAA-8AAA-111111111111",
          BROWX_IOS_DEVICE_APPS: "com.acme.app",
          BROWX_IOS_APP_ID: "com.acme.app",
          BROWX_IOS_WDA_URL: "http://192.0.2.10:8100",
        },
        makeClient: unreachable,
        devicectl: (args) => {
          seen.push(args.join(" "));
          return Promise.resolve({ result: { devices: [] } });
        },
      }),
    ).rejects.toThrow(/^ios-device-disconnected:/);
    expect(seen).toEqual(["devicectl list devices"]);
  });

  it("refuses a mistyped target", async () => {
    await expect(
      launchIosSession({ env: { BROWX_IOS_TARGET: "iphone" }, makeClient: unreachable }),
    ).rejects.toThrow(/^ios-target-invalid:/);
  });
});
