// The snapshot capability seam — a barrel. The port lives in
// `snapshot-substrate-types.ts` (no vendor type, so the
// `ports-name-no-vendor-type` dependency-cruiser rule can hold), and the three
// implementations live in their own siblings (the hybrid snapshot/a11y design):
//   - CdpSnapshotSubstrate (chromium / android) → `snapshot-substrate-cdp.ts`:
//     delegates to composeSnapshot / getA11yTree VERBATIM — the existing CDP
//     `Accessibility.getFullAXTree` + `Runtime.evaluate` DOM-walk path,
//     byte-identical output, so the 67+ chromium keystones stay green unchanged.
//   - PlaywrightSnapshotSubstrate (firefox / webkit) →
//     `snapshot-substrate-playwright.ts`: the page-side ARIA/DOM walker over
//     `frame.evaluate` (main world), minting the SAME content-hashed ref shape.
//   - SafariClassicSnapshotSubstrate (safari) → `snapshot-substrate-safari.ts`:
//     the same walker over the WebDriver Classic `execute/sync` endpoint.
// Everything is re-exported here so callers import the whole snapshot-substrate
// surface from `./snapshot-substrate.js` unchanged. (RFC 0009 P1.)

export { CdpSnapshotSubstrate } from "./snapshot-substrate-cdp.js";
export { PlaywrightSnapshotSubstrate } from "./snapshot-substrate-playwright.js";
export type { SnapshotSubstrate } from "./snapshot-substrate-types.js";
