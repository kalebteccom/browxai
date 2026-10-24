import { describe, it, expect, vi } from "vitest";
import { AndroidCdpAdapter } from "./android-cdp.js";

// The connectOverCDP transport hop drives a real browser and is exercised by the
// device-gated keystone. Here we assert the adapter's declarative surface + the
// adb ORCHESTRATION (discover → forward → /json/version → wsUrl) with mocked
// runner/fetcher, so the flow + the structured errors + the launch refusal are
// tested entirely WITHOUT a device. `connectOverCDP` itself is not invoked: every
// orchestration test that would reach it stops at a structured error first, and
// the discovery test asserts the path up to the transport hop.

describe("AndroidCdpAdapter — launch refusal (attach-only)", () => {
  it("refuses managed/ephemeral launch with android-launch-not-supported", async () => {
    const adapter = new AndroidCdpAdapter();
    await expect(adapter.launch()).rejects.toThrow(/android-launch-not-supported/);
    await expect(adapter.launch()).rejects.toThrow(/attach/i);
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
