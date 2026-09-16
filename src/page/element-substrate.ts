// The element-resolution capability seam — a barrel. The port lives in
// `element-substrate-types.ts` (it imports nothing at all, so the
// `ports-name-no-vendor-type` dependency-cruiser rule holds reachably), and the
// implementations live in their own siblings:
//   - PlaywrightElementSubstrate (chromium / firefox / webkit / android) →
//     `element-substrate-playwright.ts`: rebuilds a `Locator` from the token's
//     recipe on every call and holds nothing between them.
//   - SafariElementSubstrate (safari) → `element-substrate-safari.ts`: four
//     structured refusals, because safari declares no `element` sub-interface and
//     a plausible empty answer would be worse than none.
// Everything is re-exported here so callers import the whole element-substrate
// surface from `./element-substrate.js`. (RFC 0009 P2.)

export { PlaywrightElementSubstrate } from "./element-substrate-playwright.js";
export { SafariElementSubstrate } from "./element-substrate-safari.js";
export type {
  ElementBoundsResult,
  ElementCountResult,
  ElementProbeRequest,
  ElementProbeResult,
  ElementQuery,
  ElementReading,
  ElementRefusal,
  ElementRefusalReason,
  ElementResolution,
  ElementScope,
  ElementSubstrate,
  ElementToken,
  Rect,
} from "./element-substrate-types.js";
