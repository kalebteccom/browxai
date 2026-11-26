// The device session order (RFC 0014 §3), against fake devicectl, plutil and
// WebDriverAgent. Each refusal is pinned to the step that raises it, and to the
// fact that nothing after that step ran.

import { afterEach, describe, expect, it, vi } from "vitest";
import { launchIosDeviceSession, type IosDeviceSessionDeps } from "./device-session.js";
import { WdaClient } from "./wda-client.js";
import type { IosNativeHandle } from "../../native-types.js";
import {
  DEVICE_NAMES,
  DEVICE_UDIDS,
  PHONE_ID,
  PHONE_UDID,
} from "./__fixtures__/devicectl-devices.js";
import {
  APP_ID,
  WDA_URL,
  fakeDevicectl,
  fakePlutil,
  fakeWda,
  phoneState,
  type FakePhoneState,
} from "./__fixtures__/fake-phone.js";

const BASE_ENV = {
  BROWX_IOS_TARGET: "device",
  BROWX_IOS_DEVICE_ALLOWLIST: PHONE_ID,
  BROWX_IOS_DEVICE_APPS: `${APP_ID},com.apple.Preferences`,
  BROWX_IOS_APP_ID: APP_ID,
  BROWX_IOS_WDA_URL: WDA_URL,
};

const open: IosNativeHandle[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function rig(env: Record<string, string> = {}, state: FakePhoneState = phoneState()) {
  const devicectl = fakeDevicectl(state);
  const wda = fakeWda(state);
  const deps: IosDeviceSessionDeps = {
    env: { ...BASE_ENV, ...env },
    sessionId: "s1",
    devicectl: devicectl.run,
    plutil: fakePlutil(state),
    makeClient: (url) => new WdaClient(url, wda.http),
  };
  const launch = async (over: Partial<IosDeviceSessionDeps> = {}) => {
    const h = await launchIosDeviceSession({ ...deps, ...over });
    open.push(h);
    return h;
  };
  return { state, devicectl, wda, deps, launch };
}

describe("launchIosDeviceSession: the order", () => {
  it("opens on the allowlisted phone in the RFC's order", async () => {
    const r = rig();
    const h = await r.launch();
    expect(h.deviceId).toBe(PHONE_ID);
    expect(h.app).toEqual({ appId: APP_ID });
    expect(r.wda.calls.map((c) => `${c.method} ${c.route}`)).toEqual([
      "GET /status",
      "GET /wda/locked",
      "POST /session",
      "GET /wda/activeAppInfo",
    ]);
    expect(r.devicectl.calls).toEqual([
      "devicectl list devices",
      `devicectl device info processes --device ${PHONE_ID}`,
    ]);
  });

  it("matches the allowlist by hardware UDID and drives by CoreDevice identifier", async () => {
    const r = rig({ BROWX_IOS_DEVICE_ALLOWLIST: PHONE_UDID });
    const h = await r.launch();
    expect(h.deviceId).toBe(PHONE_ID);
    expect(r.devicectl.calls.join("\n")).not.toContain(PHONE_UDID);
  });

  it("installs the named bundle before the session, through devicectl", async () => {
    const r = rig({ BROWX_IOS_APP_PATH: "/work/Checkout.app" });
    await r.launch();
    expect(r.devicectl.calls).toContain(
      `devicectl device install app --device ${PHONE_ID} /work/Checkout.app`,
    );
    const install = r.devicectl.calls.findIndex((c) => c.includes("install app"));
    expect(install).toBeGreaterThan(0);
    expect(r.wda.calls.at(-2)?.route).toBe("/session");
  });

  it("close terminates the app under test, deletes the session and frees the lease", async () => {
    const r = rig();
    const h = await r.launch();
    open.pop();
    await h.close();
    const tail = r.wda.calls.slice(-2).map((c) => `${c.method} ${c.route}`);
    expect(tail).toEqual(["POST /wda/apps/terminate", "DELETE "]);
    const again = await r.launch({ sessionId: "s2" });
    expect(again.deviceId).toBe(PHONE_ID);
  });
});

describe("launchIosDeviceSession: refusals", () => {
  it("refuses with no allowlist before devicectl runs (G1)", async () => {
    const r = rig({ BROWX_IOS_DEVICE_ALLOWLIST: "" });
    await expect(r.launch()).rejects.toThrow(/^ios-device-not-allowlisted:/);
    expect(r.devicectl.calls).toEqual([]);
    expect(r.wda.calls).toEqual([]);
  });

  it("refuses an app under test that is off the app list (G2)", async () => {
    const r = rig({ BROWX_IOS_APP_ID: "com.acme.unlisted" });
    await expect(r.launch()).rejects.toThrow(/^ios-device-app-not-allowed:/);
    expect(r.devicectl.calls).toEqual([]);
  });

  it("refuses a system app as the app under test even when listed (G4)", async () => {
    const r = rig({ BROWX_IOS_APP_ID: "com.apple.Preferences" });
    await expect(r.launch()).rejects.toThrow(/^ios-device-system-app:/);
  });

  it("refuses the default and loopback WebDriverAgent address", async () => {
    for (const url of ["", "http://127.0.0.1:8100", "http://localhost:8100"]) {
      const r = rig({ BROWX_IOS_WDA_URL: url });
      await expect(r.launch()).rejects.toThrow(/^ios-device-wda-url:/);
    }
  });

  it("never picks a phone that is not allowlisted", async () => {
    const r = rig({ BROWX_IOS_DEVICE_ALLOWLIST: "99999999-0000-4000-8000-000000000000" });
    await expect(r.launch()).rejects.toThrow(/^ios-device-disconnected:/);
    expect(r.wda.calls).toEqual([]);
  });

  it("refuses a phone whose tunnel is down, or that is unpaired", async () => {
    const r = rig({ BROWX_IOS_DEVICE_ALLOWLIST: "22222222-BBBB-4BBB-8BBB-222222222222" });
    await expect(r.launch()).rejects.toThrow(/^ios-device-disconnected:/);
    const ipad = rig({ BROWX_IOS_DEVICE_ALLOWLIST: "33333333-CCCC-4CCC-8CCC-333333333333" });
    await expect(ipad.launch()).rejects.toThrow(/^ios-device-not-paired:/);
  });

  it("refuses a WebDriverAgent that reports a simulator (binding check 1)", async () => {
    const state = phoneState({
      status: { os: { version: "27.2" }, ios: { simulatorVersion: "27.2" } },
    });
    const r = rig({}, state);
    await expect(r.launch()).rejects.toThrow(/^ios-device-wda-mismatch:/);
    expect(r.wda.calls.map((c) => c.route)).not.toContain("/session");
  });

  it("refuses an iOS version that differs from devicectl's (binding check 2)", async () => {
    const r = rig({}, phoneState({ status: { os: { version: "26.1" } } }));
    await expect(r.launch()).rejects.toThrow(/^ios-device-wda-mismatch:.*26\.1/);
  });

  it("refuses a pid that is not running on the phone (binding check 3)", async () => {
    const r = rig({}, phoneState({ processes: [{ processIdentifier: 1 }] }));
    await expect(r.launch()).rejects.toThrow(/^ios-device-wda-mismatch:/);
    expect(r.wda.calls.at(-1)?.method).toBe("DELETE");
  });

  it("refuses a locked phone and never unlocks it (G9)", async () => {
    const r = rig({}, phoneState({ locked: true }));
    await expect(r.launch()).rejects.toThrow(/^ios-device-locked:/);
    expect(r.wda.calls.some((c) => /unlock/.test(c.route))).toBe(false);
  });

  it("refuses an install whose bundle id is off the app list", async () => {
    const r = rig(
      { BROWX_IOS_APP_PATH: "/work/Other.app" },
      phoneState({ bundleId: "com.evil.app" }),
    );
    await expect(r.launch()).rejects.toThrow(/^ios-device-app-not-allowed:/);
    expect(r.devicectl.calls.some((c) => c.includes("install app"))).toBe(false);
  });

  it("refuses when the app under test is not frontmost after launch", async () => {
    const r = rig({}, phoneState({ front: { bundleId: "com.apple.springboard", pid: 7 } }));
    await expect(r.launch()).rejects.toThrow(/^ios-device-launch-not-frontmost:/);
  });

  it("refuses a second session on the leased phone, naming the holder (G11)", async () => {
    const r = rig();
    await r.launch();
    await expect(r.launch({ sessionId: "s2" })).rejects.toThrow(/^native-device-leased:.*"s1"/);
  });

  it("frees the lease after a refusal past the lease step", async () => {
    const state = phoneState({ locked: true });
    const r = rig({}, state);
    await expect(r.launch()).rejects.toThrow(/ios-device-locked/);
    state.locked = false;
    await expect(r.launch({ sessionId: "s2" })).resolves.toBeDefined();
  });
});

describe("the phone's identity stays out of results", () => {
  it("no log line of an opened, used and closed session names the phone", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const r = rig({ BROWX_IOS_DEVICE_ALLOWLIST: PHONE_UDID, BROWX_IOS_APP_PATH: "/w/A.app" });
      const h = await r.launch();
      await h.lifecycle.launch(APP_ID);
      await h.lifecycle.terminate(APP_ID);
      await h.lifecycle.apps(false);
      open.pop();
      await h.close();
    } finally {
      spy.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [...DEVICE_NAMES, ...DEVICE_UDIDS]) {
      expect(lines.join("")).not.toContain(secret);
    }
  });

  it("no refusal names a device name or a hardware UDID", async () => {
    const cases: Array<[Record<string, string>, FakePhoneState]> = [
      [{ BROWX_IOS_DEVICE_ALLOWLIST: PHONE_UDID }, phoneState({ locked: true })],
      [
        { BROWX_IOS_DEVICE_ALLOWLIST: PHONE_UDID },
        phoneState({ status: { os: { version: "1" } } }),
      ],
      [{ BROWX_IOS_DEVICE_ALLOWLIST: "22222222-BBBB-4BBB-8BBB-222222222222" }, phoneState()],
    ];
    for (const [env, state] of cases) {
      const err = await rig(env, state)
        .launch()
        .then(
          () => "opened",
          (e: unknown) => String(e),
        );
      for (const secret of [...DEVICE_NAMES, ...DEVICE_UDIDS]) expect(err).not.toContain(secret);
    }
  });
});
