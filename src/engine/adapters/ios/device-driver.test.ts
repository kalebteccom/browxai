import { describe, expect, it } from "vitest";
import { IosDeviceDriver } from "./device-driver.js";
import { IosXcuiDriver } from "./xcui-driver.js";
import { IosPhysicalDevice } from "./device.js";
import { WdaClient } from "./wda-client.js";
import { PHONE_ID } from "./__fixtures__/devicectl-devices.js";
import { APP_ID, WDA_URL, fakeDevicectl, fakeWda, phoneState } from "./__fixtures__/fake-phone.js";

async function rig() {
  const state = phoneState();
  const wda = fakeWda(state);
  const client = new WdaClient(WDA_URL, wda.http);
  await client.newSession(APP_ID);
  const host = new IosPhysicalDevice({
    identifier: PHONE_ID,
    wda: client,
    apps: [APP_ID],
    devicectl: fakeDevicectl(state).run,
  });
  const sleeps: number[] = [];
  const driver = new IosDeviceDriver(new IosXcuiDriver(client, host), (ms) => {
    sleeps.push(ms);
    state.unreachable = false;
    return Promise.resolve();
  });
  return { driver, state, wda, sleeps };
}

describe("IosDeviceDriver", () => {
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

  it("never retries an input, and says it may have landed", async () => {
    const { driver, state, wda, sleeps } = await rig();
    state.unreachable = true;
    await expect(driver.tap({ x: 1, y: 1 })).rejects.toThrow(/^ios-device-input-unconfirmed:/);
    expect(sleeps).toEqual([]);
    expect(wda.calls.filter((c) => c.route === "/wda/tap/0")).toHaveLength(1);
  });
});
