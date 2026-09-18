// The action capability seam — a barrel. The port lives in
// `action-substrate-types.ts` (no vendor type, so the `ports-name-no-vendor-type`
// dependency-cruiser rule can hold), and the two implementations live in their own
// siblings:
//   - PlaywrightActionSubstrate (chromium / firefox / webkit / android) →
//     `action-substrate-playwright.ts`: wraps the existing `actions.*` over a
//     Playwright ActionContext — byte-identical to the pre-split path, so the four
//     engines' keystones stay green unchanged.
//   - SafariActionSubstrate (safari) → `action-substrate-safari.ts`: wraps
//     `safari-actions.*` over the WebDriver Classic client (no Playwright Page).
// Everything is re-exported here so callers (substrate-bundle.ts,
// substrate-bundle-safari.ts, host.ts, the engine registry) import the whole
// action-substrate surface from `./action-substrate.js` unchanged. (RFC 0009 P1.)

export { PlaywrightActionSubstrate } from "./action-substrate-playwright.js";
export { SafariActionSubstrate } from "./action-substrate-safari.js";
export type { ActionSubstrate } from "./action-substrate-types.js";
// The gesture vocabulary the port's `gesture(req)` member names (RFC 0009 P3).
// Re-exported here so a caller takes the whole action-substrate surface from one
// module, the same way the capture barrel re-exports `ScreenshotRequest`.
export {
  gestureToolName,
  touchDispatchUnsupported,
  TOUCH_DISPATCH_ENGINE_REFUSAL,
} from "./gesture-types.js";
export type {
  GestureRequest,
  GestureResult,
  GestureDispatched,
  GestureRefusal,
  TouchRequest,
  SwipeRequest,
  PinchRequest,
  TouchReport,
  SwipeReport,
  PinchReport,
  TouchPhase,
  Point,
} from "./gesture-types.js";
