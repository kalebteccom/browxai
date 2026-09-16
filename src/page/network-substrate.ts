// The network capability seam — a barrel. The port + result types live in
// `network-substrate-types.ts` (no vendor type, so the
// `ports-name-no-vendor-type` dependency-cruiser rule can hold), and the three
// implementations live in their own siblings (the hybrid network design, with
// Playwright events as the portable layer):
//   - CdpNetworkSubstrate (chromium / android) → `network-substrate-cdp.ts`: owns
//     the EXISTING NetworkBuffer / WsBuffer / NetworkTap / fetchResponseBody CDP
//     path VERBATIM — byte-identical buffers and per-action tap.
//   - PlaywrightNetworkSubstrate (firefox / webkit) →
//     `network-substrate-playwright.ts`: the Playwright context `request` /
//     `response` / `requestfailed` events feed the same NetworkBuffer shape.
//   - SafariNoopNetworkSubstrate (safari) → `network-substrate-safari.ts`: empty
//     rings + a zero-traffic tap; the network tools are capability-gated.
// Everything is re-exported here so callers import the whole network-substrate
// surface from `./network-substrate.js` unchanged. (RFC 0009 P1.)

export { CdpNetworkSubstrate } from "./network-substrate-cdp.js";
export { PlaywrightNetworkSubstrate } from "./network-substrate-playwright.js";
export { SafariNoopNetworkSubstrate } from "./network-substrate-safari.js";
export type {
  ActionNetworkTap,
  FetchBodyResult,
  NetworkSubstrate,
} from "./network-substrate-types.js";
