// The target-identity capability seam — a barrel. The port lives in
// `target-substrate-types.ts` (no vendor type, so the
// `ports-name-no-vendor-type` dependency-cruiser rule holds), and the two
// implementations live in their own siblings:
//   - PlaywrightTargetSubstrate (chromium / firefox / webkit / android) →
//     `target-substrate-playwright.ts`: wraps `page.url()` / `page.title()`.
//   - SafariTargetSubstrate (safari) → `target-substrate-safari.ts`: wraps the
//     WebDriver Classic `GET /url` endpoint and a `document.title` read over
//     `execute/sync`.
// Everything is re-exported here so callers import the whole target-substrate
// surface from `./target-substrate.js`. (RFC 0009 P1.)

export { PlaywrightTargetSubstrate } from "./target-substrate-playwright.js";
export { SafariTargetSubstrate } from "./target-substrate-safari.js";
export type { TargetSubstrate } from "./target-substrate-types.js";
