// `IosPhysicalDevice`, the phone's device host, against fake devicectl, plutil
// and WebDriverAgent.

import { describe, expect, it } from "vitest";
import { IosPhysicalDevice, schemeOf } from "./device.js";
import { WdaClient } from "./wda-client.js";
import { PHONE_ID } from "./__fixtures__/devicectl-devices.js";
import {
  APP_ID,
  WDA_URL,
  fakeDevicectl,
  fakePlutil,
  fakeWda,
  phoneState,
  type FakePhoneState,
} from "./__fixtures__/fake-phone.js";

async function rig(state: FakePhoneState = phoneState()) {
  const devicectl = fakeDevicectl(state);
  const wda = fakeWda(state);
  const client = new WdaClient(WDA_URL, wda.http);
  await client.newSession(APP_ID);
  const host = new IosPhysicalDevice({
    identifier: PHONE_ID,
    wda: client,
    apps: [APP_ID, "com.apple.Preferences"],
    devicectl: devicectl.run,
    plutil: fakePlutil(state),
    wdaBuild: "build 16.15.3",
  });
  return { host, devicectl, wda, state };
}

describe("IosPhysicalDevice", () => {
  it("lists only the installed apps that are on the allowlist (G2)", async () => {
    const { host } = await rig();
    expect(await host.listApps()).toEqual([
      { bundleId: APP_ID },
      { bundleId: "com.apple.Preferences" },
    ]);
  });

  it("launches and terminates through WebDriverAgent with the bundle id", async () => {
    const { host, wda } = await rig();
    await host.launch(APP_ID);
    await host.terminate(APP_ID);
    const posts = wda.calls.filter((c) => c.route.startsWith("/wda/apps/"));
    expect(posts.map((c) => [c.route, c.body])).toEqual([
      ["/wda/apps/launch", JSON.stringify({ bundleId: APP_ID })],
      ["/wda/apps/terminate", JSON.stringify({ bundleId: APP_ID })],
    ]);
  });

  it("refuses an unlisted launch with no approval, before WebDriverAgent", async () => {
    const { host, wda } = await rig();
    await expect(host.launch("com.bank.app")).rejects.toThrow(/^ios-device-app-not-allowed:/);
    await expect(host.launch("com.apple.MobileSMS")).rejects.toThrow(/^ios-device-system-app:/);
    expect(wda.calls.some((c) => c.route.startsWith("/wda/apps/"))).toBe(false);
  });

  it("refuses to terminate an unlisted app", async () => {
    const { host } = await rig();
    await expect(host.terminate("com.bank.app")).rejects.toThrow(/^ios-device-app-not-allowed:/);
  });

  it("reads the bundle id before an install and refuses one off the list", async () => {
    const { host, devicectl, state } = await rig();
    state.bundleId = "com.bank.app";
    await expect(host.install("/w/Bank.app")).rejects.toThrow(/ios-device-app-not-allowed/);
    expect(devicectl.calls.some((c) => c.includes("install app"))).toBe(false);
  });

  it("refuses a bundle whose id cannot be read", async () => {
    const { host, state } = await rig();
    state.bundleId = "";
    await expect(host.install("/w/X.app")).rejects.toThrow(/^ios-device-bundle-id-unreadable:/);
  });

  it("refuses lifecycle calls once devicectl stops listing the phone", async () => {
    const { host, state } = await rig();
    state.devices = { result: { devices: [] } };
    await expect(host.launch(APP_ID)).rejects.toThrow(/^ios-device-disconnected:/);
    await expect(host.listApps()).rejects.toThrow(/^ios-device-disconnected:/);
  });

  it("names the route and the build when WebDriverAgent lacks a route", async () => {
    const { host } = await rig(phoneState({ missingRoutes: ["/wda/apps/launch", "/url"] }));
    await expect(host.launch(APP_ID)).rejects.toThrow(
      /^ios-device-wda-route-missing:.*16\.15\.3.*\/wda\/apps\/launch/,
    );
    await expect(host.openUrl("acme://x")).rejects.toThrow(/^ios-device-deeplink-unsupported:/);
  });

  it("decodes WebDriverAgent's base64 screenshot", async () => {
    const { host } = await rig();
    expect((await host.screenshot()).toString()).toBe("PNGDATA");
  });

  it("on close stops only an allowlisted app under test, and never throws", async () => {
    const { host, wda, state } = await rig();
    await host.terminateOnClose("com.bank.app");
    expect(wda.calls.some((c) => c.route === "/wda/apps/terminate")).toBe(false);
    state.unreachable = true;
    await expect(host.terminateOnClose(APP_ID)).resolves.toBeUndefined();
  });
});

describe("schemeOf", () => {
  it("lowercases the scheme and drops the colon", () => {
    expect(schemeOf("ACME://x")).toBe("acme");
    expect(schemeOf("tel:123")).toBe("tel");
    expect(schemeOf("no scheme")).toBe("");
  });
});
