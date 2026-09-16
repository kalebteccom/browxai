// The live-emulation capability seam — a barrel. The port + result types live in
// `emulation-substrate-types.ts` (no vendor type, so the
// `ports-name-no-vendor-type` dependency-cruiser rule can hold), and the two
// implementations live in their own siblings:
//   - PlaywrightEmulationSubstrate (chromium / firefox / webkit / android) →
//     `emulation-substrate-playwright.ts`: the existing `applyGeolocation` /
//     `clearGeolocation` / `applyColorScheme` / `applyReducedMotion` over a
//     Playwright context/page, byte-identical to the pre-seam handler.
//   - SafariEmulationSubstrate (safari) → `emulation-substrate-safari.ts`: all
//     three refuse cleanly — safaridriver exposes no live-emulation surface.
// Everything is re-exported here so callers import the whole emulation-substrate
// surface from `./emulation-substrate.js` unchanged. (RFC 0009 P1.)

export { PlaywrightEmulationSubstrate } from "./emulation-substrate-playwright.js";
export { SafariEmulationSubstrate } from "./emulation-substrate-safari.js";
export type {
  EmulationApplied,
  EmulationRefusal,
  EmulationResult,
  EmulationSubstrate,
} from "./emulation-substrate-types.js";
