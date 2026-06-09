// HAR (HTTP Archive) record/replay primitives. Full-session reproducibility:
// capture every request the page made into a HAR file, then later replay a
// session with `open_session({hars:[file]})` so navigation/XHR/fetch are served
// from the archive instead of hitting the network.
//
// Recording strategy. Playwright's HAR is finalized on `context.close()` — there
// is no public mid-session flush. We honour that:
//
//   - `start_har({path?})` calls `context.routeFromHAR(harPath, {update:true,
//     updateMode:"full", updateContent:"embed"})`. From that point every request
//     in the context is logged into the in-memory HAR.
//   - `stop_har()` calls `context.unrouteAll({behavior:"wait"})` to remove the
//     recording route. The HAR FILE on disk is written when the context closes
//     (`close_session` is the standard finalize point). Until then the path is
//     reserved + tracked; the caller's flow is "start_har → drive → stop_har →
//     close_session → read the .har". This Playwright constraint is documented
//     on every return shape.
//   - For up-front recording across the whole session, prefer the additive
//     `open_session({har: {...}})` schema — that routes through Playwright's
//     `recordHar` context option, which is also finalized on close but is the
//     blessed native primitive.
//
// Replay strategy. `open_session({hars: ["file.har", ...]})` calls
// `context.routeFromHAR(file, {notFound:"fallback"})` on each path immediately
// after context creation. Files that escape the workspace are rejected (the
// `resolveWorkspacePath` helper); a missing file is a hard error (no silent
// fallback to network on a typo).
//
// Per-session state lives in `SessionEntry.har`; the registry's HAR field is
// initialised at session creation and consulted by `start_har`/`stop_har`.

import { existsSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserContext } from "playwright-core";
import { resolveWorkspacePath } from "../session/storage.js";

/** Maximum size (in bytes) at which a finalized HAR is returned inline rather
 *  than only by path. Mirrors the same cap used by `network_body` / storage
 *  dumps — agents that hit it should rely on the path field instead. */
export const HAR_INLINE_CAP_BYTES = 256 * 1024;

/** Per-session HAR recorder state. One per `SessionEntry`. */
export interface HarRecorderState {
  /** True between a successful `start_har` (or `open_session({har})`) and the
   *  next `stop_har` / session close. */
  active: boolean;
  /** Workspace-absolute path the HAR is being written to. Reserved at start. */
  path?: string;
  /** epoch ms the recorder was started. */
  startedAt?: number;
  /** Capture mode (full vs minimal). Same semantics as Playwright. */
  mode?: "full" | "minimal";
  /** Content policy — `embed` inlines bodies (default for `.har`), `attach`
   *  splits into sidecar files (default for `.zip`), `omit` drops bodies. */
  content?: "embed" | "attach" | "omit";
  /** When true, the HAR was wired at context creation via Playwright's native
   *  `recordHar` option (open_session({har:{...}})) — `stop_har` is a no-op
   *  for this case (you can't undo a context-creation primitive without
   *  closing the context). */
  nativeRecord?: boolean;
}

export function newHarRecorderState(): HarRecorderState {
  return { active: false };
}

/** Configuration accepted by `start_har` AND `open_session({har})`. */
export interface HarStartConfig {
  /** Workspace-rooted path. Optional — defaults to
   *  `<workspace>/har/<session-id>-<ISO>.har` when omitted. Path traversal
   *  outside the workspace is rejected (mirrors the storage-state contract). */
  path?: string;
  mode?: "full" | "minimal";
  content?: "embed" | "attach" | "omit";
  /** Optional URL filter (glob or regex) — only matching requests are stored. */
  urlFilter?: string;
}

/** Default HAR filename for an auto-named recording. ISO timestamp with
 *  `:` / `.` mapped to `-` so the name is filesystem-safe on every platform. */
export function defaultHarFilename(sessionId: string, now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safeId}-${iso}.har`;
}

/** Resolve an explicit user-supplied path (workspace-escape rejected) OR
 *  build the default `<workspace>/har/<auto>.har` path. Creates the parent
 *  dir on demand — still under the workspace root by construction. */
export function resolveHarPath(
  workspaceRoot: string,
  sessionId: string,
  userPath: string | undefined,
  tool: string,
): string {
  const resolved = userPath
    ? resolveWorkspacePath(workspaceRoot, userPath, tool)
    : resolveWorkspacePath(workspaceRoot, `har/${defaultHarFilename(sessionId)}`, tool);
  // `resolved` is workspace-rooted by construction (resolveWorkspacePath rejects
  // any escape from `workspaceRoot`); so `dirname(resolved)` is workspace-rooted
  // too — the mkdirSync below never touches cwd. BROWX_WORKSPACE-derived.
  const parent = dirname(resolved);
  if (parent && parent !== resolved && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  return resolved;
}

/** Validate replay HAR file paths supplied to `open_session({hars})`. Each
 *  must resolve under `$BROWX_WORKSPACE` and the file must exist (a typo
 *  silently falling back to live network would defeat the point). */
export function resolveHarReplayPaths(
  workspaceRoot: string,
  hars: readonly string[],
  tool: string,
): string[] {
  const out: string[] = [];
  for (const h of hars) {
    if (typeof h !== "string" || !h) {
      throw new Error(`${tool}: \`hars\` entries must be non-empty workspace-rooted strings`);
    }
    const resolved = resolveWorkspacePath(workspaceRoot, h, tool);
    if (!existsSync(resolved)) {
      throw new Error(`${tool}: HAR replay file not found at "${resolved}"`);
    }
    out.push(resolved);
  }
  return out;
}

/** Begin HAR recording on a live context via `routeFromHAR(update:true)`. The
 *  HAR file on disk is finalized when the context closes — this returns the
 *  reserved path and the caller is responsible for `close_session` (or the
 *  natural session teardown) to flush. Re-calling `start_har` on an already-
 *  active recorder replaces the in-flight target after a transparent stop. */
export async function startHar(
  context: BrowserContext,
  state: HarRecorderState,
  workspaceRoot: string,
  sessionId: string,
  cfg: HarStartConfig = {},
): Promise<{
  path: string;
  mode: "full" | "minimal";
  content: "embed" | "attach" | "omit";
  replacedPrior: boolean;
}> {
  if (state.nativeRecord) {
    throw new Error(
      "start_har: HAR recording was already wired at session creation via " +
        "`open_session({har})`. Close the session and re-open without the `har` " +
        "field if you need start/stop granularity.",
    );
  }
  const replacedPrior = state.active;
  if (replacedPrior) {
    // Best-effort stop of the prior recorder before swapping targets. Without
    // this a second `routeFromHAR(update:true)` chains rather than replacing.
    await context.unrouteAll({ behavior: "wait" }).catch(() => undefined);
  }
  const path = resolveHarPath(workspaceRoot, sessionId, cfg.path, "start_har");
  const mode = cfg.mode ?? "full";
  const content = cfg.content ?? "embed";
  const options: Parameters<BrowserContext["routeFromHAR"]>[1] = {
    update: true,
    updateMode: mode,
    updateContent: content === "omit" ? undefined : content,
  };
  if (cfg.urlFilter !== undefined) options.url = cfg.urlFilter;
  await context.routeFromHAR(path, options);
  state.active = true;
  state.path = path;
  state.startedAt = Date.now();
  state.mode = mode;
  state.content = content;
  state.nativeRecord = false;
  return { path, mode, content, replacedPrior };
}

/** Stop HAR recording on a live context. Removes the recording route; the HAR
 *  file is written to disk when the context closes (Playwright constraint).
 *  No-op + `{wasActive:false}` when no recorder is active. */
export async function stopHar(
  context: BrowserContext,
  state: HarRecorderState,
): Promise<{ wasActive: boolean; path?: string; finalized: boolean; nativeRecord: boolean }> {
  if (!state.active) {
    return { wasActive: false, finalized: false, nativeRecord: !!state.nativeRecord };
  }
  if (state.nativeRecord) {
    // Recording was wired at context creation — Playwright doesn't expose a
    // mid-session disable for that path. Surface the constraint instead of
    // silently lying about having stopped.
    return { wasActive: true, path: state.path, finalized: false, nativeRecord: true };
  }
  await context.unrouteAll({ behavior: "wait" }).catch(() => undefined);
  const path = state.path;
  state.active = false;
  // Keep `path` discoverable on the state until session close so callers can
  // still find the file after teardown.
  return { wasActive: true, path, finalized: false, nativeRecord: false };
}

/** Best-effort read of a finalized HAR. Used by callers that want the file
 *  inlined when small. Returns `undefined` when the file doesn't yet exist
 *  (HAR not finalized) or is over the inline cap. */
export function readHarIfSmall(
  path: string,
  capBytes: number = HAR_INLINE_CAP_BYTES,
): string | undefined {
  if (!existsSync(path)) return undefined;
  const st = statSync(path);
  if (st.size > capBytes) return undefined;
  return readFileSync(path, "utf8");
}

/** Apply replay HAR(s) to a live context. Each file is wired with
 *  `notFound:"fallback"` so a request that isn't in the archive falls through
 *  to the live network (the safer default; agents who want a hermetic replay
 *  can route the rest themselves). */
export async function applyHarReplay(
  context: BrowserContext,
  files: readonly string[],
): Promise<void> {
  for (const f of files) {
    await context.routeFromHAR(f, { notFound: "fallback" });
  }
}

/** Build the Playwright `recordHar` option for `open_session({har})`. The
 *  caller passes this into `browser.newContext({recordHar})` / equivalent
 *  on `chromium.launchPersistentContext`. */
export function buildRecordHarOption(
  workspaceRoot: string,
  sessionId: string,
  cfg: HarStartConfig,
): {
  path: string;
  mode: "full" | "minimal";
  content: "embed" | "attach" | "omit";
  recordHar: {
    path: string;
    mode?: "full" | "minimal";
    content?: "embed" | "attach" | "omit";
    urlFilter?: string | RegExp;
  };
} {
  const path = resolveHarPath(workspaceRoot, sessionId, cfg.path, "open_session");
  const mode = cfg.mode ?? "full";
  const content = cfg.content ?? "embed";
  const recordHar: {
    path: string;
    mode?: "full" | "minimal";
    content?: "embed" | "attach" | "omit";
    urlFilter?: string | RegExp;
  } = {
    path,
    mode,
    content,
  };
  if (cfg.urlFilter !== undefined) recordHar.urlFilter = cfg.urlFilter;
  // Parent dir is ensured by `resolveHarPath`. The path is workspace-rooted by
  // construction — `resolveWorkspacePath` rejects escape.
  return { path, mode, content, recordHar };
}
