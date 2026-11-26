import { describe, expect, it } from "vitest";
import { launchIosSession } from "./ios-app.engine.js";

// A device target refuses before simctl, devicectl or WebDriverAgent is reached.
// `makeClient` throws if anything gets that far.
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

  it("refuses an allowlisted phone, since this build cannot drive one", async () => {
    await expect(
      launchIosSession({
        env: {
          BROWX_IOS_TARGET: "device",
          BROWX_IOS_DEVICE_ALLOWLIST: "11111111-AAAA-4AAA-8AAA-111111111111",
          BROWX_IOS_APP_ID: "com.acme.app",
        },
        makeClient: unreachable,
      }),
    ).rejects.toThrow(/^ios-device-not-supported:/);
  });

  it("refuses a mistyped target", async () => {
    await expect(
      launchIosSession({ env: { BROWX_IOS_TARGET: "iphone" }, makeClient: unreachable }),
    ).rejects.toThrow(/^ios-target-invalid:/);
  });
});
