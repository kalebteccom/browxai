// Session video recording — Playwright's native `recordVideo` context option.
//
// Strategy. Playwright's video recorder is wired at context creation and
// finalized when the context closes — same constraint shape as the native
// `recordHar` path (see src/page/har.ts). There is NO public mid-session
// flush; the .webm on disk is written only when the page / context closes.
// We honour that:
//
//   - `open_session({recordVideo: {path?, size?}})` resolves the user-facing
//     target path (workspace-rooted; default
//     `<workspace>/videos/<sessionId>-<ISO>.webm`), then wires Playwright's
//     `recordVideo` against a staging directory under `videos/.staging/...`.
//     Playwright auto-names the file in the dir (an opaque GUID) — on
//     `close_session` we resolve that to the deterministic target path via
//     `page.video().saveAs(target)`.
//   - `stop_video({session?})` mirrors `stop_har` in the `nativeRecord:true`
//     posture: Playwright doesn't expose a mid-context stop, so the tool
//     surfaces the constraint instead of silently lying. The recorder state
//     is marked `pendingFinalize:true` and the video will land at the target
//     path when `close_session` runs.
//   - `get_video({session?, format?})` reads the finalized file off disk:
//     `format: "path"` (default) returns the absolute path; `format: "bytes"`
//     inlines as base64 when under the inline cap, else returns the path
//     with a `tooLargeToInline:true` hint. A get-before-stop call surfaces a
//     structured error pointing at `close_session` (the file isn't on disk
//     yet — Playwright constraint).
//
// Workspace-rooted by construction. Every path runs through
// `resolveWorkspacePath` (same helper as HAR / storage-state / pdf_save).
// Path traversal outside `$BROWX_WORKSPACE` is rejected.
//
// BYOB / attached. Mirror of HAR + pdf_save: the consumer's Chrome is
// not-owned and we don't wire context-creation primitives on it. The tool
// layer refuses cleanly with a structured error (see `assertVideoSupported`).

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright-core";
import { resolveWorkspacePath, resolveWorkspaceWritePath } from "../session/storage.js";
import type { VideoRecorderState, VideoRefusal, VideoStartConfig } from "./video-types.js";

// The recorder STATE and its config/refusal shapes are plain data and live above
// this module, in `video-types.ts`, so `CaptureSubstrate.prepareVideoSave` can
// name them without reaching playwright-core. Re-exported here because this is
// where every existing importer looks for them. (RFC 0009 P3.)
export type { VideoRecorderState, VideoStartConfig, VideoRefusal } from "./video-types.js";

/** Maximum size (in bytes) at which a finalized video is returned inline as
 *  base64 (`format:"bytes"`) rather than only by path. Conservative cap —
 *  video bytes balloon fast; agents that hit it should rely on the path. */
export const VIDEO_INLINE_CAP_BYTES = 1024 * 1024; // 1 MiB

export function newVideoRecorderState(): VideoRecorderState {
  return { active: false, finalized: false, pendingFinalize: false };
}

/** Refuse video on session modes Playwright's `recordVideo` doesn't support
 *  cleanly. BYOB (`attached`) is the only refusal: we don't wire
 *  context-creation primitives on the consumer's Chrome, mirroring the
 *  `pdf_save` / `recordHar` posture. Managed `persistent` and `incognito`
 *  sessions are both supported (headed and headless). */
export function assertVideoSupported(ctx: {
  mode: "persistent" | "incognito" | "attached";
}): VideoRefusal | null {
  if (ctx.mode === "attached") {
    return {
      error:
        "video recording: not supported on attached / BYOB sessions — " +
        "Playwright's `recordVideo` is a context-creation primitive and " +
        "we don't mutate the consumer's Chrome (not-owned).",
      hint:
        'open a managed session (open_session({mode:"persistent"}) or ' +
        '{mode:"incognito"}) with {recordVideo:{...}} and drive that.',
    };
  }
  return null;
}

/** Default video filename for an auto-named recording. ISO timestamp with
 *  `:` / `.` mapped to `-` so the name is filesystem-safe on every platform. */
export function defaultVideoFilename(sessionId: string, now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safeId}-${iso}.webm`;
}

/** Resolve an explicit user-supplied path (workspace-escape rejected) OR
 *  build the default `<workspace>/videos/<auto>.webm` path. Creates the
 *  parent dir on demand — still under the workspace root by construction. */
export function resolveVideoTargetPath(
  workspaceRoot: string,
  sessionId: string,
  userPath: string | undefined,
  tool: string,
): string {
  const resolved = userPath
    ? resolveWorkspaceWritePath(workspaceRoot, userPath, tool)
    : resolveWorkspacePath(workspaceRoot, `videos/${defaultVideoFilename(sessionId)}`, tool);
  // `resolved` is workspace-rooted by construction (resolveWorkspacePath
  // rejects any escape from `workspaceRoot`); `dirname(resolved)` is
  // workspace-rooted too — the mkdirSync below never touches cwd.
  // BROWX_WORKSPACE-derived.
  const parent = dirname(resolved);
  if (parent && parent !== resolved && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  return resolved;
}

/** Resolve + create the staging directory Playwright writes its auto-named
 *  .webm into. One staging dir per session, under
 *  `<workspace>/videos/.staging/<sessionId>-<ISO>/`. Workspace-rooted by
 *  construction (resolveWorkspacePath rejects escape). */
export function resolveVideoStagingDir(
  workspaceRoot: string,
  sessionId: string,
  now: Date = new Date(),
): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const stagingRel = `videos/.staging/${safeId}-${iso}`;
  // resolveWorkspacePath rejects any escape from `workspaceRoot` — the
  // resolved staging dir is BROWX_WORKSPACE-rooted by construction; the
  // mkdirSync below never touches cwd.
  const resolved = resolveWorkspacePath(workspaceRoot, stagingRel, "open_session");
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Build the Playwright `recordVideo` option for `open_session({recordVideo})`.
 *  The caller passes this into `browser.newContext({recordVideo})` /
 *  `chromium.launchPersistentContext({recordVideo})`. Returns both the
 *  Playwright-shaped option AND the resolved target path + staging dir so the
 *  registry can persist them on `VideoRecorderState`. */
export function buildRecordVideoOption(
  workspaceRoot: string,
  sessionId: string,
  cfg: VideoStartConfig,
): {
  targetPath: string;
  stagingDir: string;
  size?: { width: number; height: number };
  recordVideo: { dir: string; size?: { width: number; height: number } };
} {
  const targetPath = resolveVideoTargetPath(workspaceRoot, sessionId, cfg.path, "open_session");
  const stagingDir = resolveVideoStagingDir(workspaceRoot, sessionId);
  const recordVideo: { dir: string; size?: { width: number; height: number } } = {
    dir: stagingDir,
  };
  if (cfg.size) recordVideo.size = cfg.size;
  return { targetPath, stagingDir, size: cfg.size, recordVideo };
}

/** Mark the recorder as `pendingFinalize` — the agent has signalled they
 *  want the recording stopped. The actual flush happens on `close_session`
 *  (Playwright finalizes the .webm only when the context closes). Mirrors
 *  the `stop_har` shape for the `nativeRecord:true` posture. */
export function stopVideo(state: VideoRecorderState): {
  wasActive: boolean;
  targetPath?: string;
  pendingFinalize: boolean;
  finalized: boolean;
} {
  if (!state.active) {
    return { wasActive: false, pendingFinalize: false, finalized: state.finalized };
  }
  state.pendingFinalize = true;
  return {
    wasActive: true,
    targetPath: state.targetPath,
    pendingFinalize: true,
    finalized: state.finalized,
  };
}

/** Finalize the recording on session teardown. Calls `page.video().saveAs()`
 *  with the deterministic target path — Playwright waits for the page to
 *  close and the video to be fully written before resolving. Best-effort:
 *  errors here MUST NOT block session teardown (mirrors the `perf` /
 *  `artifacts` cleanup posture in the registry teardown). */
export async function finalizeVideoOnClose(page: Page, state: VideoRecorderState): Promise<void> {
  if (!state.active || !state.targetPath) return;
  const video = page.video();
  if (!video) {
    // recordVideo was wired but the page reports no video — best-effort.
    return;
  }
  try {
    await video.saveAs(state.targetPath);
    state.finalized = true;
  } catch {
    /* best-effort — teardown never blocks on this */
  }
}

/** Read a finalized video file. `format: "bytes"` inlines as base64 when
 *  under the cap; `format: "path"` (or over-cap) returns only the path. */
export function readVideoIfReady(
  path: string,
  format: "path" | "bytes" = "path",
  capBytes: number = VIDEO_INLINE_CAP_BYTES,
): {
  exists: boolean;
  path: string;
  bytes?: number;
  inlineBase64?: string;
  tooLargeToInline?: boolean;
} {
  if (!existsSync(path)) {
    return { exists: false, path };
  }
  const st = statSync(path);
  if (format === "path") {
    return { exists: true, path, bytes: st.size };
  }
  if (st.size > capBytes) {
    return { exists: true, path, bytes: st.size, tooLargeToInline: true };
  }
  const buf = readFileSync(path);
  return { exists: true, path, bytes: st.size, inlineBase64: buf.toString("base64") };
}
