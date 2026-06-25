// Network slice barrel. The cohesion split is a layer cut along the second
// reason-to-change: engine-blind DOMAIN shapes + pure folds live in
// `network-types.ts`; the CDP/Playwright-bound ADAPTER classes live in
// `network-cdp.ts`. This file re-exports both so callers
// (network-playwright, asset-export, actionresult, the network tests) import
// the whole network surface from the one barrel, unchanged.

// Engine-blind domain shapes + pure helpers (the leaf both adapters import).
export type {
  NetworkEntry,
  NetworkSummary,
  SessionNetworkRing,
  SessionWsRing,
  MutationEntry,
  MutationDetail,
} from "./network-types.js";
export {
  MUTATION_METHODS,
  MAX_BODY_BYTES_TO_PARSE,
  cdpTypeFromPlaywright,
  foldInteresting,
  mutationWithoutShape,
  mutationWithShape,
  patterniseUrl,
  extractTopLevelKeys,
} from "./network-types.js";

// CDP-bound adapter classes + body fetch.
export { NetworkTap, NetworkBuffer, fetchResponseBody } from "./network-cdp.js";

// ---------------------------------------------------------------------------
// WebSocket / Server-Sent-Events frame capture lives in `network-ws.ts` (the
// `WsFrame` shape + `sanitizeFrame` egress sanitiser are shared with the
// off-Chromium WS ring); re-exported here so callers use the one barrel.
export type { WsFrame } from "./network-ws.js";
export { sanitizeFrame, WsBuffer } from "./network-ws.js";

// ===========================================================================
// Off-Chromium (Playwright-events) network/WebSocket capture lives in a sibling
// module (`network-playwright.ts`) to keep this file under the size budget.
//
// RFC 0004 P4 / D10 — these classes are NOT re-exported through this barrel: a
// runtime re-export here (and `network-playwright.ts` importing runtime helpers
// back from here) formed a genuine import cycle that the no-circular rule flags
// at `error`. The sole runtime consumer (`network-substrate.ts`) now imports
// them DIRECTLY from `./network-playwright.js`, so the only surviving edge is
// `network-playwright.ts` → `network.ts` — one-directional, no cycle.
