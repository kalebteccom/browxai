// The capture capability seam — a barrel. The port + result types live in
// `capture-substrate-types.ts` (no vendor type, so the `ports-name-no-vendor-type`
// dependency-cruiser rule can hold), and the two implementations live in their own
// siblings:
//   - PlaywrightCaptureSubstrate (chromium / firefox / webkit / android) →
//     `capture-substrate-playwright.ts`: the existing screenshot logic verbatim
//     (viewport / fullPage / element-scoped, jpeg + quality + scale, the `path`
//     disk-write envelope, the `describe` caption).
//   - SafariCaptureSubstrate (safari) → `capture-substrate-safari.ts`: wraps
//     `webDriver.screenshot` (full-document PNG); the element-scoped / `path` /
//     jpeg variants refuse cleanly in the adapter.
// Everything is re-exported here so callers import the whole capture-substrate
// surface from `./capture-substrate.js` unchanged. (RFC 0009 P1.)

export { PlaywrightCaptureSubstrate } from "./capture-substrate-playwright.js";
export { SafariCaptureSubstrate } from "./capture-substrate-safari.js";
export type {
  ScreenshotRequest,
  CaptureImage,
  CaptureSaved,
  CaptureSaveError,
  CaptureRefusal,
  CaptureResult,
  CaptureSubstrate,
} from "./capture-substrate-types.js";
