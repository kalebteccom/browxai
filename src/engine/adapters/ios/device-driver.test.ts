import { describe, expect, it } from "vitest";
import { IosDeviceDriver } from "./device-driver.js";
import { IosXcuiDriver } from "./xcui-driver.js";
import { IosPhysicalDevice } from "./device.js";
import { WdaClient } from "./wda-client.js";
import { DEFAULT_DEVICE_LIMITS, DeviceRateLimiter, type DeviceLimits } from "./device-limits.js";
import { PHONE_ID } from "./__fixtures__/devicectl-devices.js";
import { APP_ID, WDA_URL, fakeDevicectl, fakeWda, phoneState } from "./__fixtures__/fake-phone.js";

async function rig(limits: Partial<DeviceLimits> = {}) {
  const state = phoneState();
  const wda = fakeWda(state);
  const client = new WdaClient(WDA_URL, wda.http);
  await client.newSession(APP_ID);
  const limiter = new DeviceRateLimiter({ ...DEFAULT_DEVICE_LIMITS, ...limits });
  const host = new IosPhysicalDevice({
    identifier: PHONE_ID,
    wda: client,
    apps: [APP_ID],
    schemes: [],
    limits: limiter,
    devicectl: fakeDevicectl(state).run,
  });
  const sleeps: number[] = [];
  const driver = new IosDeviceDriver(
    new IosXcuiDriver(client, host),
    { apps: [APP_ID], limits: limiter },
    (ms) => {
      sleeps.push(ms);
      state.unreachable = false;
      return Promise.resolve();
    },
  );
  const sent = (route: string) => wda.calls.filter((c) => c.route === route).length;
  return { driver, state, wda, sleeps, sent };
}

/** Every input verb, each as one call. */
const INPUTS: Array<[string, (d: IosDeviceDriver) => Promise<unknown>, string]> = [
  ["tap", (d) => d.tap({ x: 1, y: 1 }), "/wda/tap/0"],
  ["type", (d) => d.typeText("hi"), "/wda/keys"],
  ["set-value", (d) => d.setValue("E1", "hi"), "/element/E1/value"],
  ["swipe", (d) => d.swipe({ x: 1, y: 1 }, { x: 2, y: 2 }, 300), "/wda/dragfromtoforduration"],
  ["pinch", (d) => d.pinch({ x: 1, y: 1 }, 2, 1), "/wda/element/ROOT/pinch"],
  ["button", (d) => d.pressButton("home"), "/wda/pressButton"],
];

describe("IosDeviceDriver: the foreground fence (G5, G6)", () => {
  it.each(INPUTS)("%s refuses when an app off the list is in front", async (_n, act, route) => {
    const { driver, state, sent } = await rig();
    state.front = { bundleId: "com.whatsapp.WhatsApp", pid: 9 };
    await expect(act(driver)).rejects.toThrow(
      /^ios-device-foreground-not-allowed:.*com\.whatsapp\.WhatsApp/,
    );
    expect(sent(route)).toBe(0);
  });

  it.each(INPUTS)("%s runs when the app under test is in front", async (_n, act, route) => {
    const { driver, sent } = await rig();
    await act(driver);
    expect(sent(route)).toBeGreaterThan(0);
  });

  it("blocks snapshot and screenshot on the home screen, and says a person taps an alert", async () => {
    const { driver, state, sent } = await rig();
    state.front = { bundleId: "com.apple.springboard" };
    await expect(driver.hierarchy()).rejects.toThrow(/system alert/);
    await expect(driver.screenshot()).rejects.toThrow(/^ios-device-foreground-not-allowed:/);
    expect(sent("/source") + sent("/screenshot")).toBe(0);
  });

  it("after home, input is fenced until an allowed app is back in front (G8)", async () => {
    const { driver, state } = await rig();
    await driver.pressButton("home");
    state.front = { bundleId: "com.apple.springboard" };
    await expect(driver.tap({ x: 1, y: 1 })).rejects.toThrow(/foreground-not-allowed/);
    state.front = { bundleId: APP_ID, pid: 1 };
    await expect(driver.tap({ x: 1, y: 1 })).resolves.toBeUndefined();
  });

  it("refuses the lock button and anything else that is not home or volume (G8)", async () => {
    const { driver, sent } = await rig();
    for (const name of ["lock", "siri", "power"]) {
      await expect(driver.pressButton(name)).rejects.toThrow(/^ios-device-button-refused:/);
    }
    await driver.pressButton("volumeUp");
    await driver.pressButton("volumeDown");
    expect(sent("/wda/pressButton")).toBe(2);
  });
});

describe("IosDeviceDriver: input limits (G10)", () => {
  it("refuses the sixth input in one second and the input over the session cap", async () => {
    const { driver } = await rig({ input: 100 });
    for (let i = 0; i < 5; i++) await driver.tap({ x: 1, y: 1 });
    await expect(driver.tap({ x: 1, y: 1 })).rejects.toThrow(
      /^ios-device-rate-limit:.*5 input actions per second/,
    );
    const capped = await rig({ input: 1 });
    await capped.driver.tap({ x: 1, y: 1 });
    await expect(capped.driver.typeText("x")).rejects.toThrow(/BROWX_IOS_DEVICE_MAX_INPUTS\)/);
  });
});

describe("IosDeviceDriver: failures", () => {
  it("reports a lost WebDriverAgent session and does not open a new one", async () => {
    const { driver, state, wda } = await rig();
    state.sessionLost = true;
    await expect(driver.tap({ x: 1, y: 1 })).rejects.toThrow(/^ios-device-session-lost:/);
    await expect(driver.hierarchy()).rejects.toThrow(/^ios-device-session-lost:/);
    expect(wda.calls.filter((c) => c.method === "POST" && c.route === "/session")).toHaveLength(1);
  });

  it("retries a read once after 1 s when the network dropped", async () => {
    const { driver, state, sleeps } = await rig();
    state.unreachable = true;
    await expect(driver.screenshot()).resolves.toBeInstanceOf(Buffer);
    expect(sleeps).toEqual([1000]);
  });

  it("never retries an input", async () => {
    const { driver, state, sleeps, sent } = await rig();
    state.unreachable = true;
    await expect(driver.tap({ x: 1, y: 1 })).rejects.toThrow(/wda-unreachable/);
    expect(sleeps).toEqual([]);
    expect(sent("/wda/tap/0")).toBe(0);
  });
});
