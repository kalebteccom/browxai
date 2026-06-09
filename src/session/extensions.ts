// Per-session Chrome extension management (capability `extensions`).
//
// Chrome extensions in Playwright/Chromium are a LAUNCH-TIME concern: they
// only attach to a context that was started with `--load-extension=<paths>`
// (and `--disable-extensions-except=<paths>` to keep the rest of the user's
// extensions off in a managed profile). There is no Playwright API to add /
// remove an extension on a live context.
//
// Consequences this module's contract makes load-bearing:
//
//   1. Headed-only. Chromium has historically required a head for extensions;
//      `--headless=new` improved coverage but service-worker MV3 backgrounds
//      remain fragile. We refuse install on a session whose context was
//      launched with `headless:true`.
//
//   2. Persistent (managed) sessions only. Incognito mode does not load
//      extensions in Chromium (they require an "allowed in incognito"
//      per-extension flag that the Playwright launch API cannot toggle), and
//      attached/BYOB sessions are not-owned (the human's Chrome already has
//      its own extension set; we don't mutate it).
//
//   3. install/reload/uninstall mutate the session's extension list and then
//      REBUILD the underlying browser context. This is a destructive
//      operation: the page navigates to about:blank, open refs invalidate,
//      console/network buffers reset. Profile state on disk (cookies,
//      localStorage, IndexedDB) survives — it lives in the profile dir.
//      Callers must treat install/reload/uninstall as "session restart with
//      new extension set", not as Playwright-style hot reload.
//
//   4. `trigger` invokes an extension's keyboard command or browser-action
//      popup via the Chrome DevTools Protocol. Best-effort — many extensions
//      lack a browser-action surface, and command bindings are
//      keyboard-shortcut-only on the user's profile.
//
// The 5 tool primitives live in src/server.ts; this module supplies the pure
// helpers (manifest parsing, registry mutation, launch-arg construction) and
// the rebuild seam.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Loaded-extension record. `id` is the Chrome-computed extension id (a 32-char
 * lowercase alpha string derived from the unpacked path; deterministic given
 * the same path). `path` is the resolved absolute path on disk. `enabled` is
 * a registry-level flag — disabling without uninstall is currently a no-op
 * because Chrome won't honour a partial extension list mid-launch; reserved
 * for a future contract.
 */
export interface LoadedExtension {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
}

/** Per-session extension state. Lives on `SessionEntry.extensions`. */
export interface ExtensionRegistry {
  /** Currently-loaded extensions for this session. Empty by default. */
  loaded: LoadedExtension[];
}

export function newExtensionRegistry(): ExtensionRegistry {
  return { loaded: [] };
}

/** Result envelope for install / reload / uninstall — the standard ok/error
 *  shape the tool layer wraps with `tokensEstimate`. */
export interface ExtensionMutationResult {
  ok: true;
  loaded: LoadedExtension[];
  /** Optional note surfaced to the agent (rebuild warning, etc.). */
  note?: string;
}

/**
 * Resolve a caller-supplied `path` to an absolute workspace-rooted directory
 * containing an MV3 (or MV2) manifest. Rejects:
 *   - empty / whitespace
 *   - traversal segments (`..`) that escape the workspace
 *   - absolute paths pointing outside the workspace
 *   - non-existent paths
 *   - paths that are files (not a directory)
 *   - directories missing `manifest.json`
 *
 * Returns the resolved absolute path. Throws `Error` with a structured message
 * on any rejection — the tool handler converts that to the `ok:false` envelope.
 */
export function resolveExtensionPath(workspaceRoot: string, p: string, tool: string): string {
  const raw = (p ?? "").trim();
  if (!raw) {
    throw new Error(
      `${tool}: \`path\` is required (workspace-rooted directory containing manifest.json)`,
    );
  }
  // Resolve under the workspace root. An absolute path outside the workspace
  // is detected by the post-resolve prefix check below — `resolve()` on an
  // absolute path ignores the workspace base, so we don't need a separate
  // branch for it.
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(
      `${tool}: \`path\` must resolve inside $BROWX_WORKSPACE — got "${p}" (resolved to "${resolved}"). ` +
        `Stage the unpacked extension directory under the workspace.`,
    );
  }
  if (!existsSync(resolved)) {
    throw new Error(`${tool}: extension directory not found at "${resolved}"`);
  }
  let st;
  try {
    st = statSync(resolved);
  } catch (err) {
    throw new Error(
      `${tool}: cannot stat "${resolved}" (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(
      `${tool}: "${resolved}" is not a directory. Unpacked extensions are directories containing manifest.json (a .crx file must be unpacked first).`,
    );
  }
  if (!existsSync(join(resolved, "manifest.json"))) {
    throw new Error(
      `${tool}: no manifest.json found in "${resolved}". Pass the unpacked extension directory, not a parent.`,
    );
  }
  return resolved;
}

/** Parsed extension manifest — the minimal subset we surface to the agent. */
export interface ParsedManifest {
  name: string;
  version: string;
  manifestVersion: number;
}

export function readManifest(extPath: string, tool: string): ParsedManifest {
  const manifestPath = join(extPath, "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `${tool}: cannot read manifest.json at "${manifestPath}" (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${tool}: manifest.json at "${manifestPath}" is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${tool}: manifest.json at "${manifestPath}" must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : "(unnamed)";
  const version = typeof obj.version === "string" ? obj.version : "0.0.0";
  const mv = typeof obj.manifest_version === "number" ? obj.manifest_version : 0;
  return { name, version, manifestVersion: mv };
}

/**
 * Compute a deterministic, stable id for an unpacked extension keyed off its
 * absolute path. Chrome's real algorithm hashes the path with SHA-256 and
 * maps the first 16 bytes onto the alphabet `a-p` (32 chars). We approximate
 * with a 32-char alpha hash that's deterministic across runs given the same
 * path; the *exact* Chrome id is not required for our use cases (list /
 * reload / uninstall / trigger all key off the path or our own id mapping).
 *
 * The hash uses Node's built-in `node:crypto` — no extra dep.
 */
export function extensionIdFromPath(absPath: string): string {
  // Avoid importing crypto at the module top; lazy-require keeps the module
  // tree-shakeable and the helpers cheap to import in tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const digest = createHash("sha256").update(absPath).digest();
  const ALPHABET = "abcdefghijklmnop"; // matches Chrome's encoding alphabet
  let out = "";
  for (let i = 0; i < 16; i++) {
    const byte = digest[i] ?? 0;
    out += ALPHABET[(byte >> 4) & 0x0f];
    out += ALPHABET[byte & 0x0f];
  }
  return out;
}

/** Build the Chromium launch arguments for a given set of enabled extensions.
 *  Empty list → empty args (no extension flags). Returns a frozen array. */
export function buildLaunchArgs(loaded: ReadonlyArray<LoadedExtension>): string[] {
  const paths = loaded.filter((e) => e.enabled).map((e) => e.path);
  if (paths.length === 0) return [];
  const joined = paths.join(",");
  return [`--disable-extensions-except=${joined}`, `--load-extension=${joined}`];
}

/** Sentinel returned by the refuse predicates so the tool layer surfaces a
 *  uniform error envelope. */
export interface RefuseResult {
  ok: false;
  error: string;
  hint: string;
}

/**
 * Pure refusal predicate — returns null when the session can host extensions,
 * else a structured rejection. Mirrors the gate pattern in server.ts but is
 * pure (testable without launching Chrome).
 */
export function refuseIfUnsupported(input: {
  mode: "persistent" | "incognito" | "attached";
  headless: boolean;
  tool: string;
}): RefuseResult | null {
  if (input.mode === "attached") {
    return {
      ok: false,
      error: `${input.tool}: extension management is refused on attached/BYOB sessions`,
      hint:
        "The human's Chrome (attached over CDP) already has its own extension set installed by the human. " +
        "browxai is not-owned on attached sessions — we don't install or uninstall extensions there. " +
        "Use a managed (persistent) session if you need to drive an extension via browxai.",
    };
  }
  if (input.mode === "incognito") {
    return {
      ok: false,
      error: `${input.tool}: extension management is refused on incognito sessions`,
      hint:
        "Chromium does not load unpacked extensions in incognito launches (the per-extension 'allowed in incognito' " +
        "flag is not togglable from the Playwright launch API). Open a `persistent` (managed) session and install " +
        "the extension there.",
    };
  }
  if (input.headless) {
    return {
      ok: false,
      error: `${input.tool}: extension management requires a headed session (headless:false)`,
      hint:
        "Chromium extension loading via --load-extension is reliable only in headed mode. " +
        "Set `headless:false` via set_config({scope, patch:{headless:false}}) or BROWX_HEADLESS=0, " +
        "then open_session a fresh session. The current session's headless flag is fixed at launch.",
    };
  }
  return null;
}

/**
 * In-place mutation helper for the install operation. Pure — given the
 * current registry and a resolved + parsed install request, returns the new
 * registry. Throws on duplicate path. The tool layer is responsible for the
 * rebuild step that materialises the change.
 */
export function applyInstall(
  reg: ExtensionRegistry,
  install: { path: string; name: string; version: string },
  tool: string,
): { id: string; loaded: LoadedExtension[] } {
  if (reg.loaded.some((e) => e.path === install.path)) {
    throw new Error(
      `${tool}: extension at "${install.path}" is already loaded; call extensions_reload to re-parse its manifest`,
    );
  }
  const id = extensionIdFromPath(install.path);
  if (reg.loaded.some((e) => e.id === id)) {
    throw new Error(
      `${tool}: extension id collision for "${install.path}" (id "${id}") — this should not happen; report it.`,
    );
  }
  const next: LoadedExtension = {
    id,
    name: install.name,
    version: install.version,
    path: install.path,
    enabled: true,
  };
  return { id, loaded: [...reg.loaded, next] };
}

/**
 * Pure helper for uninstall — returns the next loaded list, throws when the
 * id isn't loaded.
 */
export function applyUninstall(
  reg: ExtensionRegistry,
  id: string,
  tool: string,
): { loaded: LoadedExtension[]; removed: LoadedExtension } {
  const idx = reg.loaded.findIndex((e) => e.id === id);
  if (idx < 0) {
    throw new Error(
      `${tool}: no extension with id "${id}" is loaded in this session (call extensions_list to see ids)`,
    );
  }
  const removed = reg.loaded[idx]!;
  return { loaded: reg.loaded.filter((_, i) => i !== idx), removed };
}

/**
 * Pure helper for reload — re-parses the manifest at the loaded path and
 * returns the next loaded list with updated name/version. The browser-context
 * rebuild is what actually re-injects content scripts; this helper just keeps
 * the registry consistent.
 */
export function applyReload(
  reg: ExtensionRegistry,
  id: string,
  parsed: ParsedManifest,
  tool: string,
): { loaded: LoadedExtension[]; entry: LoadedExtension } {
  const idx = reg.loaded.findIndex((e) => e.id === id);
  if (idx < 0) {
    throw new Error(`${tool}: no extension with id "${id}" is loaded in this session`);
  }
  const prev = reg.loaded[idx]!;
  const next: LoadedExtension = {
    ...prev,
    name: parsed.name,
    version: parsed.version,
  };
  const loaded = reg.loaded.slice();
  loaded[idx] = next;
  return { loaded, entry: next };
}
