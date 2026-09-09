// Plugin trust-tier classifier — the single canonical heuristic for
// inferring a trust tier from an install identity, shared by the CLI
// install command (`./cli.js`) and the manifest resolver
// (`./resolver.js`). Consolidated here to kill the latent drift between
// the two near-duplicate copies that previously lived in those modules.
//
// This is a LEAF: it imports only the `TrustTier` type from
// `./manifest.js` (which both call sites already depend on) and never
// imports back from `./cli.js` or `./resolver.js` — so it can be safely
// re-exported from either without forming an import cycle.
//
// The heuristic is intentionally identity-shaped so it covers both call
// sites' inputs:
//   - the CLI passes the raw install SOURCE when it is a `file:` spec
//     (so a local-path install is tagged `local`), and the resolved
//     package NAME otherwise;
//   - the resolver passes the declared package NAME (never a `file:`
//     spec — local installs are already tagged in plugins.json), so the
//     `file:` branch is simply inert for it.
// Same classification results for every input either site ever passed.

import { type TrustTier } from "./manifest.js";

/**
 * Infer a trust tier from a plugin install identity (an install source
 * spec or a package name):
 *
 *  - a `file:` source  → `local`   (local-path development install)
 *  - an `@browxai/*`   → `kalebtec` (published by Kalebtec)
 *  - everything else   → `community` (the safe default for an
 *                                     externally-sourced plugin)
 */
export function inferTrustFromInstallIdentity(identity: string): TrustTier {
  if (identity.startsWith("file:")) return "local";
  if (identity.startsWith("@browxai/")) return "kalebtec";
  return "community";
}

/**
 * Clamp a manifest's self-declared trust tier to what its package identity can
 * substantiate. `kalebtec` additionally requires the `@browxai/*` scope, so a
 * third-party package cannot self-tag as first-party and read as such on
 * `plugins_list` — the surface an operator audits. Any other declared tier
 * passes through, including a self-downgrade.
 *
 * Returns the clamped tier plus the rejected claim when one was dropped, so the
 * caller can warn with both values.
 */
export function clampDeclaredTrust(
  declared: TrustTier | undefined,
  packageName: string,
): { trust: TrustTier | undefined; rejected?: TrustTier } {
  if (declared !== "kalebtec" || packageName.startsWith("@browxai/")) return { trust: declared };
  return { trust: undefined, rejected: declared };
}
