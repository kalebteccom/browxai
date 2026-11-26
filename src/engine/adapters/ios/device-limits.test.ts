import { describe, expect, it } from "vitest";
import { DEFAULT_DEVICE_LIMITS, DeviceRateLimiter, deviceLimitsFrom } from "./device-limits.js";

describe("deviceLimitsFrom", () => {
  it("defaults to the RFC's numbers", () => {
    expect(deviceLimitsFrom({})).toEqual({
      install: 5,
      launch: 30,
      deepLink: 20,
      input: 3000,
      inputsPerSecond: 5,
    });
  });

  it("lets the operator lower or raise a limit, zero included", () => {
    const l = deviceLimitsFrom({
      BROWX_IOS_DEVICE_MAX_INSTALLS: "0",
      BROWX_IOS_DEVICE_MAX_INPUTS: "10000",
    });
    expect(l.install).toBe(0);
    expect(l.input).toBe(10000);
  });

  it("refuses a value that is not a whole number", () => {
    for (const v of ["-1", "1.5", "lots", "Infinity"]) {
      expect(() => deviceLimitsFrom({ BROWX_IOS_DEVICE_MAX_LAUNCHES: v })).toThrow(
        /^ios-device-rate-limit-invalid:/,
      );
    }
  });
});

describe("DeviceRateLimiter", () => {
  it("forbids an action whose limit is zero", () => {
    const l = new DeviceRateLimiter({ ...DEFAULT_DEVICE_LIMITS, install: 0 });
    expect(() => l.take("install")).toThrow(/limit of 0 installs/);
  });

  it("frees the per-second window after a second", () => {
    let now = 0;
    const l = new DeviceRateLimiter({ ...DEFAULT_DEVICE_LIMITS, inputsPerSecond: 2 }, () => now);
    l.take("input");
    l.take("input");
    expect(() => l.take("input")).toThrow(/per second/);
    now = 1000;
    expect(() => l.take("input")).not.toThrow();
  });

  it("does not count a refused call", () => {
    let now = 0;
    const l = new DeviceRateLimiter(
      { ...DEFAULT_DEVICE_LIMITS, input: 2, inputsPerSecond: 1 },
      () => now,
    );
    l.take("input");
    expect(() => l.take("input")).toThrow(/per second/);
    now = 5000;
    l.take("input");
    expect(() => l.take("input")).toThrow(/per session/);
  });
});
