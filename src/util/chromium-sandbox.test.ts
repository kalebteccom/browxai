import { describe, it, expect } from "vitest";
import {
  CHROMIUM_SANDBOX_MODES,
  isChromiumSandboxMode,
  parseChromiumSandbox,
  sandboxBelow,
} from "./chromium-sandbox.js";

describe("parseChromiumSandbox", () => {
  it("returns undefined for unset and blank, and the mode otherwise", () => {
    expect(parseChromiumSandbox(undefined)).toBeUndefined();
    expect(parseChromiumSandbox("  ")).toBeUndefined();
    expect(parseChromiumSandbox("auto")).toBe("auto");
    expect(parseChromiumSandbox(" ON ")).toBe("on");
    expect(parseChromiumSandbox("Off")).toBe("off");
  });

  it("throws on anything else, naming the source and the valid values", () => {
    expect(() => parseChromiumSandbox("1")).toThrow(
      /BROWX_CHROMIUM_SANDBOX: unknown value "1"\. Valid: auto, on, off/,
    );
    expect(() => parseChromiumSandbox("true", "user.chromiumSandbox")).toThrow(
      /^user\.chromiumSandbox: unknown value/,
    );
  });
});

describe("isChromiumSandboxMode", () => {
  it("accepts the three modes and nothing else", () => {
    for (const mode of CHROMIUM_SANDBOX_MODES) expect(isChromiumSandboxMode(mode)).toBe(true);
    expect(isChromiumSandboxMode("ON")).toBe(false);
    expect(isChromiumSandboxMode(true)).toBe(false);
    expect(isChromiumSandboxMode(undefined)).toBe(false);
  });
});

describe("sandboxBelow", () => {
  it("orders off below auto below on", () => {
    expect(sandboxBelow("off", "auto")).toBe(true);
    expect(sandboxBelow("off", "on")).toBe(true);
    expect(sandboxBelow("auto", "on")).toBe(true);
    expect(sandboxBelow("auto", "auto")).toBe(false);
    expect(sandboxBelow("on", "auto")).toBe(false);
    expect(sandboxBelow("on", "off")).toBe(false);
  });
});
