// Shadow DOM deep piercing — the public surface (barrel).
//
// Two layers, each in its own module behind this barrel so the historical
// `shadow.ts` import surface is unchanged for consumers and colocated tests:
//   1. Open shadow — reachable from page-side JS via `Element.shadowRoot`; the
//      shadow-tree summariser (`shadow-trees.ts`, the `shadow_trees` consumer).
//   2. Closed shadow — `Element.shadowRoot === null`, but DevTools-level access
//      via `DOM.getDocument({pierce:true})` returns the closed subtree; the
//      closed-shadow element harvest (`shadow-harvest.ts`, the `compose.ts`
//      consumer).
//
// The shared core (`CdpDomNode`, `fetchPiercedDocument`, `findByBackendId`)
// lives in `shadow-core.ts` (a leaf) so both consumers depend on it inward; this
// barrel only re-exports, so nothing imports back through it (no cycle).

export { type CdpDomNode, fetchPiercedDocument, findByBackendId } from "./shadow-core.js";
export {
  type ShadowTreeEntry,
  type ShadowChildSummary,
  type ShadowTreesOptions,
  type ShadowTreesResult,
  collectShadowTrees,
  runOpenShadowWalk,
} from "./shadow-trees.js";
export { type ClosedShadowDomEntry, harvestClosedShadowElements } from "./shadow-harvest.js";
