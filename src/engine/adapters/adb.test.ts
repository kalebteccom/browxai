import { describe, it, expect } from "vitest";
import {
  CHROME_ANDROID_SOCKET,
  AdbNotInstalledError,
  NoAndroidDeviceError,
  ChromeSocketUnreachableError,
  forwardArgs,
  parseDevices,
  selectDevice,
  extractWsUrl,
  pickFreePort,
} from "./adb.js";

// These exercise the PURE adb logic — argv construction, `adb devices` parsing,
// device selection, the /json/version → wsUrl extraction, and the structured
// errors — entirely WITHOUT a device or the adb binary. The IO half (the default
// runner/fetcher) is exercised by the device-gated keystone.

describe("adb argv construction (execFile — no shell, no injection)", () => {
  it("builds the socket forward, defaulting to the Chrome browser socket", () => {
    expect(forwardArgs(9333)).toEqual(["forward", "tcp:9333", CHROME_ANDROID_SOCKET]);
    expect(CHROME_ANDROID_SOCKET).toBe("localabstract:chrome_devtools_remote");
  });
});

describe("parseDevices — `adb devices` output", () => {
  it("skips the header + blank lines and splits serial/state (tab or space)", () => {
    const out = [
      "List of devices attached",
      "ZY223abc\tdevice",
      "emulator-5554   device",
      "",
      "BADc0ffee\tunauthorized",
      "OFFLINE99\toffline",
    ].join("\n");
    expect(parseDevices(out)).toEqual([
      { serial: "ZY223abc", state: "device" },
      { serial: "emulator-5554", state: "device" },
      { serial: "BADc0ffee", state: "unauthorized" },
      { serial: "OFFLINE99", state: "offline" },
    ]);
  });
});

describe("selectDevice — ready-device resolution", () => {
  it("throws no-device naming the unauthorized/offline rows when none is ready", () => {
    const fn = () =>
      selectDevice([
        { serial: "BADc0ffee", state: "unauthorized" },
        { serial: "OFFLINE99", state: "offline" },
      ]);
    expect(fn).toThrow(NoAndroidDeviceError);
    expect(fn).toThrow(/no-device/);
    // names what the user must fix (the RSA prompt for unauthorized).
    expect(fn).toThrow(/unauthorized|RSA/);
  });

  it("throws no-device when the requested serial is not ready", () => {
    expect(() => selectDevice([{ serial: "A", state: "unauthorized" }], "A")).toThrow(
      NoAndroidDeviceError,
    );
  });

  it("throws a structured ambiguity error when several are ready + no serial", () => {
    const fn = () =>
      selectDevice([
        { serial: "A", state: "device" },
        { serial: "B", state: "device" },
      ]);
    expect(fn).toThrow(/ambiguous-device/);
    expect(fn).toThrow(/BROWX_ANDROID_SERIAL/);
  });
});

describe("extractWsUrl — /json/version → webSocketDebuggerUrl", () => {
  it("returns the browser-level ws endpoint connectOverCDP attaches to", () => {
    const body = {
      Browser: "Chrome/126.0.6478.0",
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/abc-123",
    };
    expect(extractWsUrl(body)).toBe("ws://127.0.0.1:9333/devtools/browser/abc-123");
  });

  it("throws chrome-socket-unreachable when the field is absent (Chrome closed)", () => {
    expect(() => extractWsUrl({ Browser: "Chrome/126" })).toThrow(ChromeSocketUnreachableError);
    expect(() => extractWsUrl(null)).toThrow(/chrome-socket-unreachable/);
    expect(() => extractWsUrl({ webSocketDebuggerUrl: "" })).toThrow(ChromeSocketUnreachableError);
  });
});

describe("structured error shapes", () => {
  it("AdbNotInstalledError names the requirement (adb-missing + platform-tools)", () => {
    const e = new AdbNotInstalledError();
    expect(e.name).toBe("AdbNotInstalledError");
    expect(e.message).toContain("adb-missing");
    expect(e.message).toContain("platform-tools");
  });
});

describe("pickFreePort — loopback port selection", () => {
  it("returns a usable port in range (real bind/release, no device)", async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});
