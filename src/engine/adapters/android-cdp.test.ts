import { describe, it, expect, vi } from "vitest";
import { AndroidCdpAdapter } from "./android-cdp.js";
import { ANDROID_CAPABILITIES } from "../capabilities.js";
import { AdbNotInstalledError, NoAndroidDeviceError } from "./adb.js";

// The connectOverCDP transport hop drives a real browser and is exercised by the
// device-gated keystone. Here we assert the adapter's declarative surface + the
// adb ORCHESTRATION (discover → forward → /json/version → wsUrl) with mocked
// runner/fetcher, so the flow + the structured errors + the launch refusal are
// tested entirely WITHOUT a device. `connectOverCDP` itself is not invoked: every
// orchestration test that would reach it stops at a structured error first, and
// the discovery test asserts the path up to the transport hop.

describe("AndroidCdpAdapter — declarative surface", () => {
  it("identifies as the android engine", () => {
    expect(new AndroidCdpAdapter().engine).toBe("android");
  });

  it("exposes ANDROID_CAPABILITIES — all sub-interfaces AND deep:true (the standout)", () => {
    const adapter = new AndroidCdpAdapter();
    expect(adapter.capabilities).toBe(ANDROID_CAPABILITIES);
    // The headline: Android Chrome speaks full CDP, so unlike firefox/webkit it
    // declares deep:true — every tool works, no new substrate.
    expect(adapter.capabilities.deep).toBe(true);
    expect(adapter.capabilities.subInterfaces.size).toBe(10); // +page (RFC 0004 D5)
    expect(adapter.capabilities.engine).toBe("android");
  });
});

describe("AndroidCdpAdapter — launch refusal (attach-only)", () => {
  it("refuses managed/ephemeral launch with android-launch-not-supported", async () => {
    const adapter = new AndroidCdpAdapter();
    await expect(adapter.launch()).rejects.toThrow(/android-launch-not-supported/);
    await expect(adapter.launch()).rejects.toThrow(/attach/i);
  });
});

describe("AndroidCdpAdapter — device discovery (mocked adb)", () => {
  it("discovers the single ready device's serial", async () => {
    const runAdb = vi.fn(async () => "List of devices attached\nZY223abc\tdevice\n");
    const adapter = new AndroidCdpAdapter({ runAdb });
    expect(await adapter.discoverDevice()).toBe("ZY223abc");
    expect(runAdb).toHaveBeenCalledWith(["devices"]);
  });

  it("surfaces adb-missing (AdbNotInstalledError) without a crash", async () => {
    const runAdb = vi.fn(async () => {
      throw new AdbNotInstalledError();
    });
    const adapter = new AndroidCdpAdapter({ runAdb });
    await expect(adapter.discoverDevice()).rejects.toThrow(AdbNotInstalledError);
    await expect(adapter.discoverDevice()).rejects.toThrow(/adb-missing/);
  });

  it("surfaces no-device when only unauthorized/offline rows are present", async () => {
    const runAdb = vi.fn(
      async () => "List of devices attached\nBADc0ffee\tunauthorized\nOFF99\toffline\n",
    );
    const adapter = new AndroidCdpAdapter({ runAdb });
    await expect(adapter.discoverDevice()).rejects.toThrow(NoAndroidDeviceError);
    await expect(adapter.discoverDevice()).rejects.toThrow(/no-device/);
  });
});

describe("AndroidCdpAdapter — attach orchestration (mocked adb + fetch)", () => {
  // A runner that records every adb invocation so we can assert the forward +
  // the cleanup-on-failure (forward --remove) without a real device.
  function recordingRunner(devicesOut: string) {
    const calls: string[][] = [];
    const runAdb = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "devices" || (args[0] === "-s" && args[2] === "devices")) return devicesOut;
      return ""; // forward / forward --remove succeed silently
    });
    return { runAdb, calls };
  }

  it("forwards the Chrome socket then removes the forward when /json/version fails", async () => {
    const { runAdb, calls } = recordingRunner("List of devices attached\nZY223abc\tdevice\n");
    // The fetch fails (Chrome closed) — attach must clean up the forward it made.
    const fetchJson = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const adapter = new AndroidCdpAdapter({
      runAdb,
      fetchJson,
      pickPort: async () => 9333,
    });

    await expect(adapter.attach()).rejects.toThrow(/ECONNREFUSED/);

    // It forwarded the Chrome socket to the picked loopback port, scoped to the
    // discovered serial...
    expect(calls).toContainEqual([
      "-s",
      "ZY223abc",
      "forward",
      "tcp:9333",
      "localabstract:chrome_devtools_remote",
    ]);
    // ...and removed the forward on the failure path (no leaked adb forward).
    expect(calls).toContainEqual(["-s", "ZY223abc", "forward", "--remove", "tcp:9333"]);
    // The discovery probed /json/version on the forwarded loopback port.
    expect(fetchJson).toHaveBeenCalledWith("http://127.0.0.1:9333/json/version");
  });

  it("surfaces chrome-socket-unreachable when /json/version has no wsUrl", async () => {
    const { runAdb } = recordingRunner("List of devices attached\nZY223abc\tdevice\n");
    const fetchJson = vi.fn(async () => ({ Browser: "Chrome/126" })); // no webSocketDebuggerUrl
    const adapter = new AndroidCdpAdapter({ runAdb, fetchJson, pickPort: async () => 9333 });
    await expect(adapter.attach()).rejects.toThrow(/chrome-socket-unreachable/);
  });

  it("honours an explicit serial through discovery + forward", async () => {
    const { runAdb, calls } = recordingRunner("List of devices attached\nA\tdevice\nB\tdevice\n");
    const fetchJson = vi.fn(async () => {
      throw new Error("stop-before-connect");
    });
    const adapter = new AndroidCdpAdapter({ runAdb, fetchJson, pickPort: async () => 9001 });
    await expect(adapter.attach({ serial: "B" })).rejects.toThrow(/stop-before-connect/);
    expect(calls).toContainEqual([
      "-s",
      "B",
      "forward",
      "tcp:9001",
      "localabstract:chrome_devtools_remote",
    ]);
  });
});
