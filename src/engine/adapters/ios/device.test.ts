// `IosPhysicalDevice`, the phone's device host, against fake devicectl, plutil
// and WebDriverAgent.

import { describe, expect, it } from "vitest";
import { IosPhysicalDevice, schemeOf } from "./device.js";
import { WdaClient } from "./wda-client.js";
import { DEFAULT_DEVICE_LIMITS, DeviceRateLimiter, type DeviceLimits } from "./device-limits.js";
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

async function rig(
  state: FakePhoneState = phoneState(),
  limits: Partial<DeviceLimits> = {},
  schemes: string[] = ["acme"],
) {
  const devicectl = fakeDevicectl(state);
  const wda = fakeWda(state);
  const client = new WdaClient(WDA_URL, wda.http);
  await client.newSession(APP_ID);
  const host = new IosPhysicalDevice({
    identifier: PHONE_ID,
    wda: client,
    apps: [APP_ID, "com.apple.Preferences"],
    schemes,
    limits: new DeviceRateLimiter({ ...DEFAULT_DEVICE_LIMITS, ...limits }),
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

describe("IosPhysicalDevice: a person's approval (G3)", () => {
  it("says which launches and installs need a person, reading the bundle id for an install", async () => {
    const { host, state } = await rig();
    await expect(host.check("launch", APP_ID)).resolves.toEqual({ kind: "allow" });
    await expect(host.check("launch", "com.bank.app")).resolves.toMatchObject({
      kind: "confirm",
      appId: "com.bank.app",
    });
    await expect(host.check("launch", "com.apple.Preferences")).resolves.toMatchObject({
      kind: "confirm",
    });
    await expect(host.check("launch", "com.apple.MobileSMS")).resolves.toMatchObject({
      kind: "refuse",
    });
    state.bundleId = "com.bank.app";
    await expect(host.check("install", "/w/Bank.app")).resolves.toMatchObject({
      kind: "confirm",
      appId: "com.bank.app",
    });
  });

  it("an approval admits exactly one call of that verb on that app", async () => {
    const { host, wda } = await rig();
    host.admitOnce("launch", "com.bank.app");
    await host.launch("com.bank.app");
    await expect(host.launch("com.bank.app")).rejects.toThrow(/^ios-device-app-not-allowed:/);
    host.admitOnce("install", "com.bank.app");
    await expect(host.launch("com.bank.app")).rejects.toThrow(/ios-device-app-not-allowed/);
    expect(wda.calls.filter((c) => c.route === "/wda/apps/launch")).toHaveLength(1);
  });

  it("a listed system app needs an approval on every launch (G4)", async () => {
    const { host } = await rig();
    host.admitOnce("launch", "com.apple.Preferences");
    await host.launch("com.apple.Preferences");
    await expect(host.launch("com.apple.Preferences")).rejects.toThrow(/approval/);
  });
});

describe("IosPhysicalDevice: deep link schemes (G7)", () => {
  it("opens a listed scheme through WebDriverAgent /url", async () => {
    const { host, wda } = await rig();
    await host.openUrl("ACME://checkout/42");
    expect(wda.calls.at(-1)).toMatchObject({ route: "/url" });
  });

  it("refuses an unlisted scheme before WebDriverAgent, and every scheme when the list is empty", async () => {
    const listed = await rig();
    for (const url of ["tel:123", "sms:1", "https://example.com", "prefs:root=General"]) {
      await expect(listed.host.openUrl(url)).rejects.toThrow(/^ios-device-scheme-not-allowed:/);
    }
    const empty = await rig(phoneState(), {}, []);
    await expect(empty.host.openUrl("acme://x")).rejects.toThrow(/list is empty/);
    expect([...listed.wda.calls, ...empty.wda.calls].some((c) => c.route === "/url")).toBe(false);
  });
});

describe("IosPhysicalDevice: rate limits (G10)", () => {
  it("refuses the call over each limit and names the variable", async () => {
    const { host, state } = await rig(phoneState(), { install: 1, launch: 2, deepLink: 1 });
    await host.install("/w/A.app");
    await expect(host.install("/w/A.app")).rejects.toThrow(
      /^ios-device-rate-limit:.*1 installs.*BROWX_IOS_DEVICE_MAX_INSTALLS/,
    );
    await host.launch(APP_ID);
    await host.terminate(APP_ID);
    await expect(host.launch(APP_ID)).rejects.toThrow(/BROWX_IOS_DEVICE_MAX_LAUNCHES/);
    await host.openUrl("acme://a");
    await expect(host.openUrl("acme://b")).rejects.toThrow(/BROWX_IOS_DEVICE_MAX_DEEP_LINKS/);
    expect(state).toBeDefined();
  });

  it("does not count the close path's terminate", async () => {
    const { host } = await rig(phoneState(), { launch: 0 });
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
