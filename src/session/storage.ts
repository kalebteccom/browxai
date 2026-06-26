// Three-layer storage-state primitives — .
//
// The deferred bulk-state ask, with the @playwright/mcp lesson baked
// in: bulk alone isn't enough — adopters constantly need to read a single
// cookie ("am I logged in?") or set one ("opt-out=1") without round-tripping
// a full blob. So three layers ship together:
//
//   1. Bulk     — `dump_storage_state` / `inject_storage_state` (wraps
//                  `BrowserContext.storageState()` / `setStorageState()`).
//   2. Granular — cookies + localStorage + sessionStorage CRUD (cookies via
//                  Playwright's `BrowserContext.addCookies`/`cookies`/
//                  `clearCookies`; web-storage via `page.evaluate(...)` since
//                  it's origin-scoped — the page MUST be navigated to the
//                  target origin first).
//   3. Named    — `auth_save({name})` / `auth_load({name})` wrap layer 1 with
//                  workspace-rooted JSON files at
//                  `$BROWX_WORKSPACE/.auth-states/<name>.json`. No parallel
//                  implementation — they delegate to layer 1.
//
// Capability split (server.ts):
//   - reads  (`*_get`, `*_list`, `dump_storage_state`)              → `read`
//   - writes (`*_set`, `*_delete`, `*_clear`,
//             `inject_storage_state`, `auth_save`, `auth_load`)     → `action`
//
// Workspace contract: every `path` arg resolves inside `$BROWX_WORKSPACE`;
// path-traversal is rejected (same posture as `upload_file`). Named-state
// names are restricted to a safe character set (no separators, no `..`).
//
// Secrets-masking interplay: cookie *values* may carry credentials. A
// future secrets-masking pass will mask them on egress. For now the gap
// is documented; no extra work here.

import { sep, join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import { assertSafeName, isSafeName, resolveWorkspacePath } from "../util/workspace.js";

/** Playwright's `storageState()` return shape (re-stated locally so callers
 *  don't need to depend on playwright-core directly). */
export interface StorageStateBlob {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/** Cookie shape Playwright accepts in `addCookies`. */
export interface CookieInput {
  name: string;
  value: string;
  /** Either `url` OR (`domain` + `path`) is required. */
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

// ---- workspace path / name validators -------------------------------------
// Moved to src/util/workspace.ts (the no-trace chokepoint now lives beside the
// root resolver, so util-layer modules depend on it inward instead of reaching
// up into session). Re-exported here so the storage-state callers that import
// them from this module keep working unchanged.
export { assertSafeName, resolveWorkspacePath };

// ---- layer 1: bulk --------------------------------------------------------

/** Dump the context's storage state. Optionally writes JSON to a
 *  workspace-rooted path; ALWAYS returns the blob. */
export async function dumpStorageState(
  context: BrowserContext,
  workspaceRoot: string,
  opts: { path?: string } = {},
): Promise<{ state: StorageStateBlob; path?: string; bytes?: number }> {
  const state = await context.storageState();
  if (opts.path === undefined) return { state };
  // `resolved` is workspace-rooted by construction — `resolveWorkspacePath`
  // (above) rejects any path outside `workspace.root` / $BROWX_WORKSPACE.
  const resolved = resolveWorkspacePath(workspaceRoot, opts.path, "dump_storage_state");
  const json = JSON.stringify(state, null, 2);
  // ensure parent dir exists — still under workspace.root by construction.
  const parent = resolved.substring(0, Math.max(resolved.lastIndexOf(sep), 0));
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(resolved, json, "utf8");
  return { state, path: resolved, bytes: Buffer.byteLength(json, "utf8") };
}

/** Read + validate a state blob from a workspace-rooted file path. */
export function readStorageStateFile(
  workspaceRoot: string,
  p: string,
  tool: string,
): StorageStateBlob {
  const resolved = resolveWorkspacePath(workspaceRoot, p, tool);
  if (!existsSync(resolved)) {
    throw new Error(`${tool}: storage-state file not found at "${resolved}"`);
  }
  const raw = readFileSync(resolved, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${tool}: storage-state file "${resolved}" is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  validateStorageStateShape(parsed, tool);
  return parsed as StorageStateBlob;
}

function validateStorageStateShape(value: unknown, tool: string): void {
  if (!value || typeof value !== "object") {
    throw new Error(
      `${tool}: storage-state must be an object with \`cookies\` and \`origins\` arrays`,
    );
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.cookies)) {
    throw new Error(`${tool}: storage-state.\`cookies\` must be an array`);
  }
  if (!Array.isArray(v.origins)) {
    throw new Error(`${tool}: storage-state.\`origins\` must be an array`);
  }
}

/** Inject a storage-state into an EXISTING context. Two modes:
 *    - `replace` (default) — wipes the context's cookies/localStorage/IndexedDB
 *      and applies the new state. Uses Playwright's `setStorageState`.
 *    - `merge`  — adds cookies via `addCookies` without clearing; localStorage
 *      merge requires a navigation to each origin and runs via `page.evaluate`
 *      (best-effort: only the currently-loaded page's origin is updated; other
 *      origins in the blob are skipped with a note in the result). */
export async function injectStorageState(
  context: BrowserContext,
  page: Page,
  state: StorageStateBlob,
  opts: { mode?: "replace" | "merge" } = {},
): Promise<{
  mode: "replace" | "merge";
  cookiesApplied: number;
  originsApplied: number;
  originsSkipped: string[];
}> {
  const mode = opts.mode ?? "replace";
  if (mode === "replace") {
    // setStorageState clears existing cookies + localStorage + IndexedDB first.
    await context.setStorageState(state);
    return {
      mode,
      cookiesApplied: state.cookies.length,
      originsApplied: state.origins.length,
      originsSkipped: [],
    };
  }
  // merge: cookies are safe to add without clearing.
  if (state.cookies.length) await context.addCookies(state.cookies);
  let originsApplied = 0;
  const originsSkipped: string[] = [];
  const currentOrigin = (() => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return null;
    }
  })();
  for (const o of state.origins) {
    if (currentOrigin === o.origin) {
      await page.evaluate((entries: ReadonlyArray<{ name: string; value: string }>) => {
        for (const e of entries) window.localStorage.setItem(e.name, e.value);
      }, o.localStorage);
      originsApplied += 1;
    } else {
      originsSkipped.push(o.origin);
    }
  }
  return { mode, cookiesApplied: state.cookies.length, originsApplied, originsSkipped };
}

// ---- layer 2: cookies CRUD ------------------------------------------------

export async function cookiesGet(
  context: BrowserContext,
  args: { name: string; url?: string },
): Promise<StorageStateBlob["cookies"][number] | null> {
  if (!args.name) throw new Error("cookies_get: `name` is required");
  const list = await context.cookies(args.url ? [args.url] : undefined);
  return list.find((c) => c.name === args.name) ?? null;
}

export async function cookiesList(
  context: BrowserContext,
  args: { urls?: string[] } = {},
): Promise<StorageStateBlob["cookies"]> {
  const list = await context.cookies(args.urls);
  return list;
}

export async function cookiesSet(
  context: BrowserContext,
  args: CookieInput,
): Promise<{ ok: true }> {
  if (!args.name) throw new Error("cookies_set: `name` is required");
  if (typeof args.value !== "string") throw new Error("cookies_set: `value` (string) is required");
  if (!args.url && !(args.domain && args.path)) {
    throw new Error(
      "cookies_set: pass either `url` (recommended) OR both `domain` and `path` — " +
        "Playwright's addCookies requires one of those two forms",
    );
  }
  await context.addCookies([args]);
  return { ok: true };
}

/** The cookie `path` Playwright assigns when `addCookies` is given a `url`:
 *  the parent directory of the url path ("/storage" → "/", "/a/b" → "/a/").
 *  Used so `cookies_delete` filters by the same path the URL-form
 *  `cookies_set` stored under. */
function urlCookiePath(pathname: string): string {
  return pathname.substring(0, pathname.lastIndexOf("/") + 1) || "/";
}

export async function cookiesDelete(
  context: BrowserContext,
  args: { name: string; url?: string; domain?: string; path?: string },
): Promise<{ ok: true }> {
  if (!args.name) throw new Error("cookies_delete: `name` is required");
  // `clearCookies` accepts a filter — name + (optional) url / domain / path.
  const filter: { name?: string; domain?: string; path?: string } = { name: args.name };
  if (args.domain) filter.domain = args.domain;
  if (args.path) filter.path = args.path;
  if (args.url) {
    try {
      const u = new URL(args.url);
      filter.domain = filter.domain ?? u.hostname;
      // Match Playwright's URL→cookie-path rule (the parent "directory" of the
      // url path), so a delete by the SAME url that `cookies_set` used actually
      // matches: addCookies({url}) stores e.g. "/storage" at path "/", so a
      // delete filter of the raw pathname "/storage" would match nothing.
      filter.path = filter.path ?? urlCookiePath(u.pathname);
    } catch {
      throw new Error(`cookies_delete: invalid url "${args.url}"`);
    }
  }
  await context.clearCookies(filter);
  return { ok: true };
}

export async function cookiesClear(context: BrowserContext): Promise<{ ok: true }> {
  await context.clearCookies();
  return { ok: true };
}

// ---- layer 2: web-storage (local + session) -------------------------------

/** Storage kind — exact same JS surface, different storage object. */
export type WebStorageKind = "localStorage" | "sessionStorage";

/** localStorage/sessionStorage are origin-scoped and tied to the current
 *  page; we must drive them via `page.evaluate`. The page MUST be navigated
 *  to the target origin first — on `about:blank` or a different origin the
 *  call throws a Playwright SecurityError, which we re-frame with a clearer
 *  hint. */
function webStorageGuard(page: Page, kind: WebStorageKind, tool: string): void {
  let url: string;
  try {
    url = page.url();
  } catch {
    url = "";
  }
  if (!url || url === "about:blank") {
    throw new Error(
      `${tool}: ${kind} is origin-scoped and the page is at "${url || "(unknown)"}". ` +
        `Navigate the session to the target origin first.`,
    );
  }
}

// Browser-side storage references — string form to avoid pulling the DOM
// lib into tsconfig. Mirrors `src/page/shortcut.ts`. The `kind` parameter is
// the literal `localStorage` or `sessionStorage` member name on `window`.

export async function webStorageGet(
  page: Page,
  kind: WebStorageKind,
  args: { key: string },
  tool: string,
): Promise<{ value: string | null; origin: string }> {
  if (!args.key) throw new Error(`${tool}: \`key\` is required`);
  webStorageGuard(page, kind, tool);
  const expr =
    `(() => { var s = window.${kind}; ` +
    `return { value: s.getItem(${JSON.stringify(args.key)}), origin: window.location.origin }; })()`;
  return await page.evaluate(expr);
}

export async function webStorageSet(
  page: Page,
  kind: WebStorageKind,
  args: { key: string; value: string },
  tool: string,
): Promise<{ ok: true; origin: string }> {
  if (!args.key) throw new Error(`${tool}: \`key\` is required`);
  if (typeof args.value !== "string") throw new Error(`${tool}: \`value\` (string) is required`);
  webStorageGuard(page, kind, tool);
  const expr =
    `(() => { var s = window.${kind}; ` +
    `s.setItem(${JSON.stringify(args.key)}, ${JSON.stringify(args.value)}); ` +
    `return { ok: true, origin: window.location.origin }; })()`;
  return await page.evaluate(expr);
}

export async function webStorageList(
  page: Page,
  kind: WebStorageKind,
  tool: string,
): Promise<{ entries: Array<{ key: string; value: string }>; origin: string }> {
  webStorageGuard(page, kind, tool);
  const expr =
    `(() => { var s = window.${kind}; var out = []; ` +
    `for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k === null) continue; ` +
    `out.push({ key: k, value: s.getItem(k) || "" }); } ` +
    `return { entries: out, origin: window.location.origin }; })()`;
  return await page.evaluate(expr);
}

export async function webStorageDelete(
  page: Page,
  kind: WebStorageKind,
  args: { key: string },
  tool: string,
): Promise<{ ok: true; origin: string }> {
  if (!args.key) throw new Error(`${tool}: \`key\` is required`);
  webStorageGuard(page, kind, tool);
  const expr =
    `(() => { var s = window.${kind}; s.removeItem(${JSON.stringify(args.key)}); ` +
    `return { ok: true, origin: window.location.origin }; })()`;
  return await page.evaluate(expr);
}

export async function webStorageClear(
  page: Page,
  kind: WebStorageKind,
  tool: string,
): Promise<{ ok: true; origin: string }> {
  webStorageGuard(page, kind, tool);
  const expr =
    `(() => { var s = window.${kind}; s.clear(); ` +
    `return { ok: true, origin: window.location.origin }; })()`;
  return await page.evaluate(expr);
}

// ---- layer 3: named auth-states -------------------------------------------

const AUTH_STATES_DIR = ".auth-states";

/** Resolve the on-disk path for a named auth-state. Validates the name. */
export function authStatePath(workspaceRoot: string, name: string): string {
  assertSafeName("auth state name", name);
  return join(workspaceRoot, AUTH_STATES_DIR, `${name}.json`);
}

/** Capture the context's storage state into the named slot. Overwrites an
 *  existing slot of the same name. */
export async function authSave(
  context: BrowserContext,
  workspaceRoot: string,
  name: string,
): Promise<{
  ok: true;
  name: string;
  path: string;
  bytes: number;
  cookies: number;
  origins: number;
}> {
  // `dest` + `dir` below are rooted at `workspaceRoot` ($BROWX_WORKSPACE) by
  // construction — `authStatePath` validates the name through `assertSafeName`
  // (no separators / no traversal) before joining under workspaceRoot.
  const dest = authStatePath(workspaceRoot, name);
  const dir = join(workspaceRoot, AUTH_STATES_DIR);
  // workspace.root-rooted by construction (see comment above).
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const state = await context.storageState();
  const json = JSON.stringify(state, null, 2);
  // workspace.root-rooted by construction (see comment above).
  writeFileSync(dest, json, "utf8");
  return {
    ok: true,
    name,
    path: dest,
    bytes: Buffer.byteLength(json, "utf8"),
    cookies: state.cookies.length,
    origins: state.origins.length,
  };
}

/** Load a named auth-state from disk. Returns the parsed blob ready to feed
 *  into `open_session({ storageState })` or `inject_storage_state`. */
export function authLoad(workspaceRoot: string, name: string): StorageStateBlob {
  const path = authStatePath(workspaceRoot, name);
  if (!existsSync(path)) {
    throw new Error(
      `auth_load: no named state "${name}" — call auth_save({ name }) first (looked for ${path})`,
    );
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `auth_load: named state "${name}" is corrupt JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  validateStorageStateShape(parsed, "auth_load");
  return parsed as StorageStateBlob;
}

/** Enumerate every named state in the workspace. Read-only; returns
 *  `{name, path, bytes, modifiedAt}` per slot. */
export function authList(
  workspaceRoot: string,
): Array<{ name: string; path: string; bytes: number; modifiedAt: string }> {
  const dir = join(workspaceRoot, AUTH_STATES_DIR);
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; path: string; bytes: number; modifiedAt: string }> = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    if (!isSafeName(name)) continue;
    const path = join(dir, entry);
    try {
      const st = statSync(path);
      out.push({ name, path, bytes: st.size, modifiedAt: new Date(st.mtimeMs).toISOString() });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Delete a named state. Returns whether the slot existed. */
export function authDelete(
  workspaceRoot: string,
  name: string,
): { ok: true; existed: boolean; path: string } {
  const path = authStatePath(workspaceRoot, name);
  const existed = existsSync(path);
  if (existed) rmSync(path, { force: true });
  return { ok: true, existed, path };
}
