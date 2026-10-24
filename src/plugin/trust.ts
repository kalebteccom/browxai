// Plugin trust-tier classifier, shared by the CLI install command (`./cli.js`)
// and the manifest resolver (`./resolver.js`).
//
// The `kalebtec` (first-party) tier rests on how the package was installed,
// as plugins-lock.json records it. A package name alone proves nothing: an
// installer can alias any package to an `@browxai/*` name
// (`@browxai/x@npm:other`), and a git or path dependency can call itself
// `@browxai/...` in its own package.json. So the tier needs all of:
//   - an `@browxai/*` name,
//   - a lock entry whose recorded spec is a plain registry spec of exactly that
//     name (`@browxai/plugin-figma`, `@browxai/plugin-figma@^0.1.0`): no `npm:`
//     alias, git, tarball URL or `file:` path,
//   - the registry integrity hash the package manager recorded, copied into
//     the lock entry,
//   - an installed package.json `name` equal to the declared name.
// Anything else is `community`, or `local` for a `file:` install.
//
// This is a LEAF: it imports only types, so either call site can re-export it
// without forming an import cycle.

import type { LockEntry } from "./lock-store.js";
import type { TrustTier } from "./manifest.js";

const FIRST_PARTY_NAME = /^@browxai\/[a-z0-9][a-z0-9._-]*$/;

/** The range part of a plain registry spec: a version, a semver range or a
 *  dist-tag. No `:` and no `/`, so no alias, git, URL or path. */
const REGISTRY_RANGE = /^[A-Za-z0-9.^~<>=*|+ -]+$/;

/** True when `spec` asks the registry for `name` itself: `name` or
 *  `name@<version|range|tag>`. */
export function isPlainRegistrySpec(spec: string, name: string): boolean {
  if (spec === name) return true;
  if (!spec.startsWith(`${name}@`)) return false;
  const range = spec.slice(name.length + 1);
  return range.trim().length > 0 && REGISTRY_RANGE.test(range);
}

/**
 * True when plugins-lock.json shows `name` was installed from the registry
 * under its own `@browxai/*` name, with an integrity hash. `installedName` is
 * the `name` field of the installed package.json, when the caller has read it.
 */
export function isVerifiedFirstParty(
  name: string,
  entry: Pick<LockEntry, "name" | "source" | "integrity"> | undefined,
  installedName?: string,
): boolean {
  if (!FIRST_PARTY_NAME.test(name)) return false;
  if (installedName !== undefined && installedName !== name) return false;
  if (!entry || entry.name !== name) return false;
  if (typeof entry.integrity !== "string" || entry.integrity.length === 0) return false;
  return isPlainRegistrySpec(entry.source, name);
}

/**
 * Trust tier for an install: a `file:` source is `local`, a verified
 * first-party install is `kalebtec`, everything else is `community`.
 */
export function inferTrustFromInstallIdentity(
  identity: string,
  verifiedFirstParty: boolean,
): TrustTier {
  if (identity.startsWith("file:")) return "local";
  return verifiedFirstParty ? "kalebtec" : "community";
}

/**
 * Clamp a declared trust tier (a manifest's own claim, or a `plugins.json`
 * override) to what the install can substantiate. `kalebtec` stands only for a
 * verified first-party install. Any other declared tier passes through,
 * including a downgrade.
 *
 * Returns the clamped tier plus the rejected claim when one was dropped, so the
 * caller can warn with both values.
 */
export function clampDeclaredTrust(
  declared: TrustTier | undefined,
  verifiedFirstParty: boolean,
): { trust: TrustTier | undefined; rejected?: TrustTier } {
  if (declared !== "kalebtec" || verifiedFirstParty) return { trust: declared };
  return { trust: undefined, rejected: declared };
}
