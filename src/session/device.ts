// resolve a device/viewport spec into a DeviceConfig.
//
// Two inputs, either or both:
//   - `device`: a Playwright built-in device preset name ("iPhone 14",
//     "Pixel 7", "Desktop Chrome", …) → viewport + DPR + isMobile + hasTouch
//     + userAgent.
//   - `viewport`: explicit { width, height } — overrides the preset's viewport
//     (lets you pin a custom size while keeping a preset's mobile/touch/UA).
//
// Pure + dependency-light: `devices` is a static table from playwright-core.

import { devices } from "playwright-core";
import type { DeviceConfig } from "./types.js";

export interface DeviceSpec {
  device?: string;
  viewport?: { width: number; height: number };
}

export class UnknownDeviceError extends Error {
  constructor(name: string, sample: string[]) {
    super(
      `unknown device preset "${name}". Examples: ${sample.join(", ")}. ` +
        `Any Playwright device name works (see playwright devices registry).`,
    );
    this.name = "UnknownDeviceError";
  }
}

/** Resolve a spec into a DeviceConfig, or undefined when nothing was asked for.
 *  Throws UnknownDeviceError for an unrecognised preset name. */
export function resolveDevice(spec: DeviceSpec | undefined): DeviceConfig | undefined {
  if (!spec || (!spec.device && !spec.viewport)) return undefined;
  let cfg: DeviceConfig = {};
  if (spec.device) {
    const preset = (
      devices as Record<
        string,
        {
          viewport?: { width: number; height: number };
          deviceScaleFactor?: number;
          isMobile?: boolean;
          hasTouch?: boolean;
          userAgent?: string;
        }
      >
    )[spec.device];
    if (!preset) {
      const sample = Object.keys(devices)
        .filter((n) => /iPhone 1[34]|Pixel 7|Desktop Chrome/.test(n))
        .slice(0, 4);
      throw new UnknownDeviceError(
        spec.device,
        sample.length ? sample : Object.keys(devices).slice(0, 4),
      );
    }
    cfg = {
      viewport: preset.viewport,
      deviceScaleFactor: preset.deviceScaleFactor,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
      userAgent: preset.userAgent,
    };
  }
  if (spec.viewport) cfg = { ...cfg, viewport: spec.viewport };
  return cfg;
}
