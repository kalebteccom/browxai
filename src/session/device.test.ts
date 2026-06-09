import { describe, it, expect } from "vitest";
import { devices } from "playwright-core";
import { resolveDevice, UnknownDeviceError } from "./device.js";

describe("resolveDevice", () => {
  it("returns undefined when nothing is specified", () => {
    expect(resolveDevice(undefined)).toBeUndefined();
    expect(resolveDevice({})).toBeUndefined();
  });

  it("resolves a known Playwright preset to its full DeviceConfig", () => {
    // Pick a preset that exists in the bundled registry.
    const name = Object.keys(devices).find((n) => /iPhone/.test(n))!;
    const cfg = resolveDevice({ device: name })!;
    const preset = (
      devices as Record<string, { viewport?: unknown; isMobile?: boolean; userAgent?: string }>
    )[name]!;
    expect(cfg.viewport).toEqual(preset.viewport);
    expect(cfg.isMobile).toBe(preset.isMobile);
    expect(cfg.userAgent).toBe(preset.userAgent);
  });

  it("explicit viewport overrides a preset's viewport but keeps its mobile/UA", () => {
    const name = Object.keys(devices).find((n) => /iPhone/.test(n))!;
    const cfg = resolveDevice({ device: name, viewport: { width: 1234, height: 567 } })!;
    expect(cfg.viewport).toEqual({ width: 1234, height: 567 });
    const preset = (devices as Record<string, { isMobile?: boolean }>)[name]!;
    expect(cfg.isMobile).toBe(preset.isMobile); // preset traits preserved
  });

  it("viewport-only spec yields a config with just the viewport", () => {
    expect(resolveDevice({ viewport: { width: 800, height: 600 } })).toEqual({
      viewport: { width: 800, height: 600 },
    });
  });

  it("throws UnknownDeviceError for an unrecognised preset", () => {
    expect(() => resolveDevice({ device: "Nonexistent Phone 999" })).toThrow(UnknownDeviceError);
    try {
      resolveDevice({ device: "Nonexistent Phone 999" });
    } catch (e) {
      expect((e as Error).message).toMatch(/unknown device preset/);
    }
  });
});
