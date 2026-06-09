// Plugin manifest shape + validator.
//
// Every browxai plugin ships a `"browxai"` field on its `package.json`
// (the standard npm package-metadata file). That field carries the
// machine-readable contract the runtime resolves against — entry point,
// tool namespace, declared capabilities, declared dependencies on other
// plugins, trust tier, the API version range the plugin was built for.
//
// Why a sub-field on package.json rather than a sidecar JSON file?
//   - npm/pnpm already keep `package.json` honest at install time.
//   - Adopters can `pnpm add` a plugin from npm without an out-of-band
//     "browxai-config" download step.
//   - The conventional `package.json` `version` + `name` fields are the
//     canonical version + identity the runtime trusts.
//
// The runtime validates the field with the Zod schema in this module. A
// failing validation marks the plugin `load-error` with a structured
// message — server start does NOT abort because of one bad plugin.

import { z } from "zod";

/**
 * Trust tiers. The host operator is the only party who can configure which
 * plugins to enable (via plugins.json), so trust is an advisory signal —
 * the runtime treats `kalebtec` / `community` / `local` identically at
 * capability-gate / call-graph-enforcement time. Surfaced on `plugins_list`
 * so the operator can audit.
 *
 *  - `kalebtec`  — published by Kalebtec under `@kalebtec/browxai-plugin-*`.
 *                  Reference plugins; same release/CI hygiene as the host.
 *  - `community` — third-party npm packages (`browxai-plugin-*` or
 *                  `@<org>/browxai-plugin-*`). Adopter installs by name.
 *  - `local`     — file-path-installed plugins. Used during plugin
 *                  development (`browxai plugin install file:./my-plugin/`).
 */
export const TRUST_TIERS = ["kalebtec", "community", "local"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/**
 * Inter-plugin dependency. `plugin` is the npm package name of another
 * browxai plugin this one composes with. `version` is a semver range the
 * dep must satisfy (e.g. `^1.0.0`). Matched against the dep plugin's
 * `package.json#version` at load-time.
 */
export const dependsOnEntrySchema = z.object({
  plugin: z.string().min(1, "dependsOn[].plugin: must be a non-empty npm package name"),
  version: z
    .string()
    .min(1, "dependsOn[].version: must be a non-empty semver range, e.g. '^1.0.0'"),
});
export type DependsOnEntry = z.infer<typeof dependsOnEntrySchema>;

/**
 * The full plugin manifest, as embedded under `package.json#browxai`.
 *
 *   apiVersion       semver of the plugin-runtime contract the plugin codes
 *                    against. The runtime advertises its own supported range
 *                    (see RUNTIME_API_VERSION below); a plugin whose
 *                    apiVersion does not satisfy is rejected at load-time.
 *
 *   browxaiVersion   semver range of the host browxai package the plugin
 *                    was tested against. Advisory — surfaced in
 *                    plugins_list, but a mismatch only warns (so a
 *                    conservative range doesn't lock out a known-good
 *                    host that already shipped). Authors can tighten this
 *                    if needed.
 *
 *   namespace        MANDATORY tool prefix. Every tool a plugin registers
 *                    is `<namespace>.<tool>`. The runtime rejects any
 *                    other shape. Namespaces must be globally unique
 *                    across the loaded plugin set — two plugins claiming
 *                    `figma` both fail with a clear error.
 *
 *   register         Relative path to the JS module the runtime imports.
 *                    The module must export a `register(api)` function
 *                    (default export OR named `register`).
 *
 *   capabilities     Capabilities the plugin's tools need. Subset of the
 *                    server's enabled set at load time. Mismatch →
 *                    plugin disabled (status: disabled-by-capability-mismatch),
 *                    server still starts. Empty array means "no
 *                    capability-gated tools" — perfectly fine.
 *
 *   trust            Trust tier. The CLI tags this based on the install
 *                    source; authors may set it on `kalebtec` packages but
 *                    the CLI overrides on community / local installs.
 *
 *   dependsOn        Other browxai plugins this one calls into. The
 *                    runtime composes these into a directed graph;
 *                    cycles abort startup; call-graph enforcement at
 *                    runtime refuses calls outside the declared
 *                    transitive set.
 */
export const browxaiManifestSchema = z.object({
  apiVersion: z.string().min(1, "browxai.apiVersion: missing"),
  browxaiVersion: z.string().min(1, "browxai.browxaiVersion: missing").optional(),
  namespace: z
    .string()
    .min(1, "browxai.namespace: missing")
    // Lowercase identifier — must not collide with reserved core
    // namespaces. `_` allowed; no `.`/`:` (those are tool-name separators).
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "browxai.namespace: must match /^[a-z][a-z0-9_]*$/ (lowercase, alphanumeric + underscore, starts with a letter)",
    ),
  register: z.string().min(1, "browxai.register: missing entry-point path"),
  capabilities: z.array(z.string()).default([]),
  trust: z.enum(TRUST_TIERS).optional(),
  dependsOn: z.array(dependsOnEntrySchema).default([]),
});
export type BrowxaiManifestData = z.infer<typeof browxaiManifestSchema>;

/**
 * Fully-resolved plugin manifest the runtime works with. Composes the
 * Zod-validated `browxai` field with metadata read off the rest of
 * `package.json` (name, version, description), the absolute path the
 * plugin was loaded from, and the resolved trust tier (CLI-overridden
 * for community / local installs).
 */
export interface ResolvedManifest {
  /** npm package name (`package.json#name`). */
  readonly name: string;
  /** npm semver of the installed version (`package.json#version`). */
  readonly version: string;
  /** Optional human-readable description. */
  readonly description?: string;
  /** Absolute path the plugin was loaded from. */
  readonly path: string;
  /** Absolute path to the JS entry file (resolved from `register`). */
  readonly entryPath: string;
  /** Resolved trust tier (CLI tags community / local installs). */
  readonly trust: TrustTier;
  /** Parsed + validated `package.json#browxai` field. */
  readonly browxai: BrowxaiManifestData;
}

/**
 * The plugin-runtime API contract version. Plugin manifests declare
 * `apiVersion`; the runtime checks plugin.apiVersion startsWith the
 * runtime's major.
 *
 * Phase 8 ships 1.0 — the first stable runtime contract. Breaking
 * changes here are deferred to a major-version bump.
 */
export const RUNTIME_API_VERSION = "1.0.0";

/**
 * Reserved namespaces a plugin may NOT claim. Core browxai tools live in
 * the implicit-root namespace; reserving the obvious aliases here
 * prevents an early plugin from squatting them.
 */
export const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  "browxai",
  "browx",
  "core",
  "system",
  "plugins",
]);

/**
 * Validate a parsed `package.json#browxai` field. Returns the typed
 * manifest data on success; throws on validation failure. Caller maps
 * the throw to a `load-error` status (so server start continues).
 */
export function parseManifestField(raw: unknown): BrowxaiManifestData {
  const parsed = browxaiManifestSchema.parse(raw);
  if (RESERVED_NAMESPACES.has(parsed.namespace)) {
    throw new Error(
      `browxai.namespace: "${parsed.namespace}" is reserved for the core surface. ` +
        `Pick a project-unique namespace (e.g. "${parsed.namespace}_${Math.floor(Math.random() * 1000)}").`,
    );
  }
  return parsed;
}

/**
 * Lightweight semver-major compatibility check used at apiVersion time.
 *
 * The runtime advertises {@link RUNTIME_API_VERSION}; a plugin manifest
 * carries an apiVersion. We don't pull in a full semver lib — the check
 * is "the plugin's apiVersion has the same MAJOR as the runtime, and the
 * plugin's MINOR is ≤ runtime's MINOR". This is the standard semver
 * "library guarantees backwards compat within a major" assumption and
 * is enough for the Phase-8 contract.
 *
 * A plugin built for `1.0.0` works under runtime `1.5.0`; a plugin built
 * for `1.5.0` does NOT work under runtime `1.0.0` (newer API surface).
 * A plugin built for `2.0.0` does NOT work under runtime `1.x` (major
 * gap).
 */
export function isApiVersionCompatible(
  pluginApiVersion: string,
  runtimeApiVersion: string = RUNTIME_API_VERSION,
): boolean {
  const a = parseVersion(pluginApiVersion);
  const b = parseVersion(runtimeApiVersion);
  if (!a || !b) return false;
  if (a.major !== b.major) return false;
  if (a.minor > b.minor) return false;
  return true;
}

function parseVersion(s: string): { major: number; minor: number; patch: number } | null {
  // Tolerate leading `^` / `~` / `>=` / `=` so adopters can paste a
  // semver-range string into apiVersion. The runtime ignores the operator
  // and treats the rest as a concrete version.
  const stripped = s.replace(/^(\^|~|>=|<=|=|>|<)/, "").trim();
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(stripped);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Match a plugin's installed version against a semver range from a
 * `dependsOn[].version` entry. Kept dep-free; supports the common
 * shapes (`^x.y.z`, `~x.y.z`, exact, `>=x.y.z`, `*`).
 */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === "*" || trimmed === "") return true;
  const v = parseVersion(version);
  if (!v) return false;
  if (trimmed.startsWith("^")) {
    const r = parseVersion(trimmed.slice(1));
    if (!r) return false;
    if (v.major !== r.major) return false;
    if (v.major === 0) {
      // ^0.x.y locks minor too (npm convention).
      if (v.minor !== r.minor) return false;
      return v.patch >= r.patch || (v.patch === r.patch && true);
    }
    return v.minor > r.minor || (v.minor === r.minor && v.patch >= r.patch);
  }
  if (trimmed.startsWith("~")) {
    const r = parseVersion(trimmed.slice(1));
    if (!r) return false;
    if (v.major !== r.major || v.minor !== r.minor) return false;
    return v.patch >= r.patch;
  }
  if (trimmed.startsWith(">=")) {
    const r = parseVersion(trimmed.slice(2).trim());
    if (!r) return false;
    return (
      v.major > r.major ||
      (v.major === r.major && v.minor > r.minor) ||
      (v.major === r.major && v.minor === r.minor && v.patch >= r.patch)
    );
  }
  // Exact (with or without leading `=`).
  const r = parseVersion(trimmed.replace(/^=/, ""));
  if (!r) return false;
  return v.major === r.major && v.minor === r.minor && v.patch === r.patch;
}
