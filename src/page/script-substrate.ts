// The script (page-eval) capability seam — a barrel. The port lives in
// `script-substrate-types.ts` (no vendor type, so the `ports-name-no-vendor-type`
// dependency-cruiser rule can hold), and the two implementations live in their own
// siblings:
//   - PlaywrightScriptSubstrate (chromium / firefox / webkit / android) →
//     `script-substrate-playwright.ts`: wraps `page.evaluate(expr)` verbatim.
//   - SafariScriptSubstrate (safari) → `script-substrate-safari.ts`: wraps
//     `webDriver.executeScript` over the WebDriver Classic `execute/sync` endpoint.
// Everything is re-exported here so callers import the whole script-substrate
// surface from `./script-substrate.js` unchanged. (RFC 0009 P1.)

export { PlaywrightScriptSubstrate } from "./script-substrate-playwright.js";
export { SafariScriptSubstrate } from "./script-substrate-safari.js";
export type { ScriptSubstrate } from "./script-substrate-types.js";
