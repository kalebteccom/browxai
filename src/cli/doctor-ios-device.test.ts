import { describe, expect, it } from "vitest";
import { iosDeviceChecks, type IosDeviceDoctorDeps } from "./doctor-ios-device.js";
import type { CommandRunner } from "./macos-app.js";
import type { Check } from "./doctor.js";
import type { DevicectlRunner, WdaHttp } from "../engine/index.js";
import {
  DEVICE_NAMES,
  DEVICE_UDIDS,
  DEVICECTL_LIST,
  OTHER_PHONE_ID,
  PHONE_ID,
  PHONE_UDID,
} from "../engine/adapters/ios/__fixtures__/devicectl-devices.js";

const WDA = "http://192.0.2.10:8100";

const READY_STATUS = {
  value: {
    ready: true,
    state: "success",
    os: { name: "iOS", version: "27.2" },
    build: { productBundleIdentifier: "com.facebook.WebDriverAgentRunner" },
  },
};

interface Setup {
  env?: NodeJS.ProcessEnv;
  versionStatus?: number | null;
  devices?: unknown;
  status?: unknown;
  statusHttp?: number;
  locked?: unknown;
}

function deps(s: Setup = {}): {
  deps: IosDeviceDoctorDeps;
  commands: string[];
  devicectlCalls: number;
  urls: string[];
} {
  const commands: string[] = [];
  const urls: string[] = [];
  const out = { devicectlCalls: 0 };
  const run: CommandRunner = (file, args) => {
    commands.push([file, ...args].join(" "));
    const status = s.versionStatus === undefined ? 0 : s.versionStatus;
    return { status, stdout: status === 0 ? "397.21\n" : "", stderr: "" };
  };
  const devicectl: DevicectlRunner = async () => {
    out.devicectlCalls++;
    if (s.devices instanceof Error) throw s.devices;
    return s.devices === undefined ? DEVICECTL_LIST : s.devices;
  };
  const http: WdaHttp = async (url) => {
    urls.push(url);
    const body = url.endsWith("/status")
      ? (s.status ?? READY_STATUS)
      : (s.locked ?? { value: false });
    if (body instanceof Error) throw body;
    const status = url.endsWith("/status") ? (s.statusHttp ?? 200) : 200;
    return { ok: status < 400, status, text: JSON.stringify(body) };
  };
  const env: NodeJS.ProcessEnv = s.env ?? {
    BROWX_IOS_TARGET: "device",
    BROWX_IOS_DEVICE_ALLOWLIST: PHONE_ID,
    BROWX_IOS_DEVICE_APPS: "com.acme.app",
    BROWX_IOS_APP_ID: "com.acme.app",
    BROWX_IOS_WDA_URL: WDA,
  };
  return {
    deps: { env, run, devicectl, http },
    commands,
    get devicectlCalls() {
      return out.devicectlCalls;
    },
    urls,
  };
}

const DEVICE_ENV: NodeJS.ProcessEnv = {
  BROWX_IOS_TARGET: "device",
  BROWX_IOS_DEVICE_ALLOWLIST: PHONE_ID,
  BROWX_IOS_DEVICE_APPS: "com.acme.app",
  BROWX_IOS_APP_ID: "com.acme.app",
  BROWX_IOS_WDA_URL: WDA,
};

const warns = (rows: Check[]): string[] => rows.filter((r) => r.warn).map((r) => r.detail);
const find = (rows: Check[], prefix: string): Check | undefined =>
  rows.find((r) => r.detail.startsWith(prefix));

describe("ios-device doctor rows: when they appear", () => {
  it("adds nothing for the default target on another engine, and runs nothing", async () => {
    const f = deps({ env: {} });
    expect(await iosDeviceChecks({ ...f.deps, iosEngineSelected: false })).toEqual([]);
    expect(f.commands).toEqual([]);
    expect(f.devicectlCalls).toBe(0);
  });

  it("adds one informational row for the simulator target on ios-app", async () => {
    const f = deps({ env: {} });
    const rows = await iosDeviceChecks({ ...f.deps, iosEngineSelected: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "ios-device", ok: true, info: true });
    expect(rows[0]?.enable).toMatch(/BROWX_IOS_TARGET=device/);
    expect(f.commands).toEqual([]);
  });

  it("warns on a mistyped target and never fails doctor", async () => {
    const rows = await iosDeviceChecks(deps({ env: { BROWX_IOS_TARGET: "phone" } }).deps);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, warn: true });
    expect(rows[0]?.detail).toMatch(/ios-target-invalid/);
  });
});

describe("ios-device doctor rows: a ready phone", () => {
  it("passes every row and never fails doctor", async () => {
    const f = deps();
    const rows = await iosDeviceChecks(f.deps);
    expect(warns(rows)).toEqual([]);
    expect(rows.every((r) => r.ok && r.name === "ios-device")).toBe(true);
    expect(rows.map((r) => r.detail)).toEqual([
      "allowlist: 1 phone, 1 app",
      "devicectl present (397.21)",
      "found iPhone 17e, iOS 27.2, localNetwork",
      "trust: paired",
      "tunnel: connected over localNetwork",
      "Developer Mode: enabled",
      "developer services: available",
      "WebDriverAgent: ready",
      "WebDriverAgent build: iOS 27.2",
      "lock state: open",
    ]);
    expect(f.commands).toEqual(["xcrun devicectl --version"]);
    expect(f.urls).toEqual([`${WDA}/status`, `${WDA}/wda/locked`]);
  });

  it("matches the phone by hardware UDID too", async () => {
    const env = { ...DEVICE_ENV, BROWX_IOS_DEVICE_ALLOWLIST: PHONE_UDID };
    const rows = await iosDeviceChecks(deps({ env }).deps);
    expect(find(rows, "found ")?.warn).toBeUndefined();
  });

  it("never prints a device name, a UDID or the phone's address", async () => {
    const env = { ...DEVICE_ENV, BROWX_IOS_DEVICE_ALLOWLIST: PHONE_UDID };
    for (const setup of [
      { env },
      { env, status: new Error(`wda-unreachable: no WebDriverAgent answered at ${WDA}`) },
    ]) {
      const text = JSON.stringify(await iosDeviceChecks(deps(setup).deps));
      for (const name of DEVICE_NAMES) expect(text).not.toContain(name);
      for (const udid of DEVICE_UDIDS) expect(text).not.toContain(udid);
      expect(text).not.toContain("192.0.2.10");
    }
  });
});

describe("ios-device doctor rows: each warning", () => {
  it("warns on an empty allowlist and an empty app list", async () => {
    const env = { BROWX_IOS_TARGET: "device", BROWX_IOS_WDA_URL: WDA };
    const row = (await iosDeviceChecks(deps({ env }).deps))[0]!;
    expect(row).toMatchObject({ warn: true, detail: "allowlist: 0 phones, 0 apps" });
    expect(row.fix).toMatch(/BROWX_IOS_DEVICE_ALLOWLIST/);
    expect(row.fix).toMatch(/BROWX_IOS_DEVICE_APPS/);
  });

  it("warns when the app under test is off the app list", async () => {
    const env = { ...DEVICE_ENV, BROWX_IOS_APP_ID: "com.other.app" };
    const row = (await iosDeviceChecks(deps({ env }).deps))[0]!;
    expect(row.warn).toBe(true);
    expect(row.fix).toMatch(/BROWX_IOS_APP_ID is not on BROWX_IOS_DEVICE_APPS/);
  });

  it("warns when BROWX_IOS_DEVICE is off the list, or two phones and none named", async () => {
    const off = { ...DEVICE_ENV, BROWX_IOS_DEVICE: OTHER_PHONE_ID };
    const offRows = await iosDeviceChecks(deps({ env: off }).deps);
    expect(offRows[0]?.fix).toMatch(/BROWX_IOS_DEVICE is not on/);
    expect(find(offRows, "no named allowlisted phone")?.warn).toBe(true);

    const two = { ...DEVICE_ENV, BROWX_IOS_DEVICE_ALLOWLIST: `${PHONE_ID},${OTHER_PHONE_ID}` };
    const twoRows = await iosDeviceChecks(deps({ env: two }).deps);
    expect(twoRows[0]?.fix).toMatch(/more than one phone/);
    expect(find(twoRows, "no named allowlisted phone")?.detail).toMatch(/2 allowlisted, 1 other/);
  });

  it("warns when devicectl is missing, and skips the phone rows", async () => {
    const f = deps({ versionStatus: null });
    const rows = await iosDeviceChecks(f.deps);
    expect(find(rows, "devicectl not found")?.warn).toBe(true);
    expect(f.devicectlCalls).toBe(0);
    expect(find(rows, "found ")).toBeUndefined();
  });

  it("warns when devicectl list fails", async () => {
    const rows = await iosDeviceChecks(deps({ devices: new Error("xcrun failed: boom") }).deps);
    expect(find(rows, "devicectl list devices failed")?.warn).toBe(true);
  });

  it("warns on trust, tunnel, Developer Mode and developer services", async () => {
    const env = {
      ...DEVICE_ENV,
      BROWX_IOS_DEVICE_ALLOWLIST: "33333333-CCCC-4CCC-8CCC-333333333333",
    };
    const rows = await iosDeviceChecks(deps({ env }).deps);
    expect(warns(rows)).toEqual(
      expect.arrayContaining([
        "trust: unpaired",
        "tunnel: unavailable",
        "Developer Mode: disabled",
        "developer services: not available",
      ]),
    );
  });

  it("warns on an unset, malformed or loopback WebDriverAgent URL, and sends nothing", async () => {
    for (const url of [undefined, "not a url", "http://127.0.0.1:8100", "http://localhost:8100"]) {
      const env = { ...DEVICE_ENV, BROWX_IOS_WDA_URL: url };
      const f = deps({ env });
      const rows = await iosDeviceChecks(f.deps);
      expect(find(rows, "WebDriverAgent URL:")?.warn, String(url)).toBe(true);
      expect(f.urls).toEqual([]);
    }
  });

  it("names Local Network first when the tunnel is up and /status does not answer", async () => {
    const rows = await iosDeviceChecks(deps({ status: new Error("ECONNREFUSED") }).deps);
    const row = find(rows, "WebDriverAgent: no answer")!;
    expect(row.warn).toBe(true);
    expect(row.fix).toMatch(/^allow the program that started browxai in System Settings/);
  });

  it("names the runner first when the tunnel is down", async () => {
    const env = { ...DEVICE_ENV, BROWX_IOS_DEVICE_ALLOWLIST: OTHER_PHONE_ID };
    const rows = await iosDeviceChecks(deps({ env, status: new Error("timeout") }).deps);
    expect(find(rows, "WebDriverAgent: no answer")?.fix).toMatch(/^check that the runner/);
  });

  it("warns when WebDriverAgent is not ready", async () => {
    const notReady = await iosDeviceChecks(deps({ status: { value: { ready: false } } }).deps);
    expect(find(notReady, "WebDriverAgent: answered and is not ready")?.warn).toBe(true);
    const http500 = await iosDeviceChecks(deps({ statusHttp: 500 }).deps);
    expect(find(http500, "WebDriverAgent: answered and is not ready")?.warn).toBe(true);
  });

  it("warns when /status reports a simulator or another iOS version", async () => {
    const sim = {
      value: { ready: true, os: { version: "27.2" }, ios: { simulatorVersion: "27.2" } },
    };
    expect(
      find(await iosDeviceChecks(deps({ status: sim }).deps), "WebDriverAgent build"),
    ).toMatchObject({ warn: true, detail: "WebDriverAgent build: reports a simulator" });
    const other = { value: { ready: true, os: { version: "26.1" } } };
    expect(
      find(await iosDeviceChecks(deps({ status: other }).deps), "WebDriverAgent build")?.detail,
    ).toBe("WebDriverAgent build: iOS 26.1, devicectl reports iOS 27.2");
  });

  it("warns when the phone is locked, and is informational when the route is missing", async () => {
    const locked = await iosDeviceChecks(deps({ locked: { value: true } }).deps);
    expect(find(locked, "lock state")).toMatchObject({ warn: true, detail: "lock state: locked" });
    const missing = await iosDeviceChecks(deps({ locked: new Error("404") }).deps);
    expect(find(missing, "lock state")).toMatchObject({ info: true });
  });
});
