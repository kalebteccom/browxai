// Plugin manifest resolver — reads `<workspace>/plugins.json`
// and the installed-package manifests under
// `<workspace>/plugins/node_modules/<pkg>/package.json`.
//
// The declarative file (`plugins.json`) is the source of truth for
// "which plugins should the server load". The lock file
// (`plugins-lock.json`) carries the resolved version + content-hash
// pin for reproducibility. The lock is only written / consulted by the
// CLI install/remove/upgrade/sync commands — the runtime only reads
// `plugins.json`.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { ZodError } from "zod";
import { log } from "../util/logging.js";
import { parseManifestField, type ResolvedManifest, type TrustTier } from "./manifest.js";
import { inferTrustFromInstallIdentity } from "./trust.js";

/** Per-entry overrides in the object form of `plugins.json`. */
export interface PluginEntryOverride {
  readonly enabled?: boolean;
  readonly trust?: TrustTier;
}

/**
 * `plugins.json` declaration. Two equivalent shapes accepted for
 * ergonomics:
 *
 *   Array form:
 *     { "plugins": ["@browxai/plugin-example", ...] }
 *
 *   Object form (lets the operator pin trust tier overrides per entry):
 *     {
 *       "plugins": {
 *         "@browxai/plugin-example": { "enabled": true },
 *         "my-local-plugin": { "enabled": false, "trust": "local" }
 *       }
 *     }
 *
 * `enabled: false` means "declared but skipped at server start" — used
 * to disable a plugin without uninstalling it.
 */
export interface PluginsJsonFile {
  readonly plugins: ReadonlyArray<string> | Readonly<Record<string, PluginEntryOverride>>;
}

export interface DeclaredPlugin {
  /** npm package name. */
  readonly name: string;
  /** Whether the operator wants it active. */
  readonly enabled: boolean;
  /** Optional operator-supplied trust override. */
  readonly trust?: TrustTier;
}

/**
 * The subset of an installed plugin's `package.json` we read off disk.
 * `browxai` stays `unknown` because the field is validated separately
 * via {@link parseManifestField}; the other fields are optional strings.
 */
interface PackageJsonManifest {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly browxai?: unknown;
}

/** Workspace path conventions — single source of truth. The workspace
 *  root is whatever `resolveWorkspace().root` returns (default
 *  `~/.browxai/`); the plugin file conventions live directly under it
 *  so adopters with a custom BROWX_WORKSPACE keep everything in one
 *  tree. */
export interface PluginPaths {
  /** Workspace root — same as `resolveWorkspace().root`. */
  readonly root: string;
  /** `<workspace>/plugins.json` — declarative truth. */
  readonly declarationFile: string;
  /** `<workspace>/plugins-lock.json` — auto-generated pin. */
  readonly lockFile: string;
  /** `<workspace>/plugins/` — install dir for pnpm. */
  readonly installDir: string;
  /** `<workspace>/plugins/node_modules/` — pnpm install target. */
  readonly nodeModulesDir: string;
}

export function pluginPaths(workspaceRoot: string): PluginPaths {
  return {
    root: workspaceRoot,
    declarationFile: join(workspaceRoot, "plugins.json"),
    lockFile: join(workspaceRoot, "plugins-lock.json"),
    installDir: join(workspaceRoot, "plugins"),
    nodeModulesDir: join(workspaceRoot, "plugins", "node_modules"),
  };
}

/**
 * Read + normalise the `plugins.json` file. Returns an empty list when
 * the file is missing or malformed (with a warning) — server start
 * never aborts on a bad config file.
 */
export function readDeclaration(paths: PluginPaths): ReadonlyArray<DeclaredPlugin> {
  if (!existsSync(paths.declarationFile)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.declarationFile, "utf8"));
  } catch (e) {
    log.warn(`plugin runtime: ${paths.declarationFile} is malformed — ignoring`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const decl = (raw as PluginsJsonFile).plugins;
  if (!decl) return [];
  // `isArrayForm` narrows the union to its array member here and —
  // crucially — subtracts that member in the `else` branch. The built-in
  // `Array.isArray` only guards `any[]`, which can't subtract the
  // `readonly string[]` branch, leaving the `Object.entries` values below
  // typed as `any`.
  if (isArrayForm(decl)) {
    return decl
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .map((name) => ({ name, enabled: true }));
  }
  if (typeof decl === "object") {
    const out: DeclaredPlugin[] = [];
    for (const [name, entry] of Object.entries(decl)) {
      if (!entry || typeof entry !== "object") continue;
      out.push({
        name,
        enabled: entry.enabled !== false,
        ...(entry.trust ? { trust: entry.trust } : {}),
      });
    }
    return out;
  }
  return [];
}

/**
 * Result of trying to resolve one declared plugin's manifest off disk.
 * `kind` discriminates: a `not-installed` entry surfaces as a load
 * error in the runtime; an `invalid-manifest` entry too. Both keep
 * server start running.
 */
export type ResolveResult =
  | { readonly kind: "resolved"; readonly manifest: ResolvedManifest }
  | { readonly kind: "not-installed"; readonly name: string }
  | { readonly kind: "invalid-manifest"; readonly name: string; readonly error: string };

/**
 * Resolve one plugin's manifest. Side-effect free — reads `package.json`
 * and the `browxai` field, validates the field, returns a typed result.
 *
 * `trustOverride` (from `plugins.json`) wins; otherwise the trust tier
 * comes from the manifest itself, defaulting to `community` (the safe
 * assumption for an externally-sourced plugin).
 */
export function resolveDeclaredPlugin(paths: PluginPaths, decl: DeclaredPlugin): ResolveResult {
  const pkgRoot = join(paths.nodeModulesDir, decl.name);
  const pkgJsonPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return { kind: "not-installed", name: decl.name };
  }
  let raw: PackageJsonManifest;
  try {
    raw = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as PackageJsonManifest;
  } catch (e) {
    return {
      kind: "invalid-manifest",
      name: decl.name,
      error: `package.json is malformed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!raw.browxai) {
    return {
      kind: "invalid-manifest",
      name: decl.name,
      error: `package.json#browxai field is missing — not a browxai plugin`,
    };
  }
  let manifest;
  try {
    manifest = parseManifestField(raw.browxai);
  } catch (e) {
    if (e instanceof ZodError) {
      return {
        kind: "invalid-manifest",
        name: decl.name,
        error: e.issues
          .map((iss) => `${iss.path.join(".") || "<root>"}: ${iss.message}`)
          .join("; "),
      };
    }
    return {
      kind: "invalid-manifest",
      name: decl.name,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const entryPath = resolvePath(pkgRoot, manifest.register);
  if (!existsSync(entryPath)) {
    return {
      kind: "invalid-manifest",
      name: decl.name,
      error: `browxai.register points at ${manifest.register} but resolved path ${entryPath} does not exist`,
    };
  }
  const trust: TrustTier = decl.trust ?? manifest.trust ?? inferTrustFromInstallIdentity(decl.name);
  return {
    kind: "resolved",
    manifest: {
      name: raw.name ?? decl.name,
      version: raw.version ?? "0.0.0",
      ...(raw.description ? { description: raw.description } : {}),
      path: pkgRoot,
      entryPath,
      trust,
      browxai: manifest,
    },
  };
}

/**
 * Narrows the `plugins.json` value to its array form. Unlike the built-in
 * `Array.isArray` (which only guards `any[]`), this predicate is keyed to
 * the declared union, so the `else` branch correctly leaves only the
 * object form — keeping `Object.entries` strongly typed.
 */
function isArrayForm(decl: PluginsJsonFile["plugins"]): decl is ReadonlyArray<string> {
  return Array.isArray(decl);
}
