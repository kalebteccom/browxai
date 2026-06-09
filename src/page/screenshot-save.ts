// `screenshot` — workspace-rooted file-write extension.
//
// The `screenshot` tool's default mode returns inline base64 image bytes (an
// MCP `image` content part). When the caller supplies a `path`, the bytes are
// written to a workspace-rooted file instead, and the result swaps the inline
// image for a `{ ok, path, bytes, format, fullPage }` JSON envelope.
//
// This module owns the disk-write side only — buffer encoding stays with the
// tool layer (Playwright's `page.screenshot()` / `locator.screenshot()` already
// produced the buffer by the time we're called). Mirrors the `pdf_save` split:
// the consequential write goes through `resolveWorkspacePath` so a path
// escaping `$BROWX_WORKSPACE` is rejected before any byte hits disk.
//
// Capability gating happens at the tool layer (see `src/server.ts`): when
// `path` is set, `file-io` is required in addition to the screenshot tool's
// own `read` gate. Default (no `path`) behaviour is unchanged — no capability
// change, no disk write.

import { resolve as resolvePath, dirname } from "node:path";
import { statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolveWorkspacePath } from "../session/storage.js";

/** Image format the bytes were encoded as. Matches the existing tool surface
 *  (`png` / `jpeg`); kept narrow so the result is self-describing without
 *  the caller having to remember what they asked for. */
export type ScreenshotFormat = "png" | "jpeg";

export interface ScreenshotSaveArgs {
  /** Workspace-rooted file path. Resolved inside `$BROWX_WORKSPACE` — a path
   *  escaping the workspace is rejected up-front (same chokepoint
   *  `pdf_save` / `start_har` / `dump_storage_state` use). */
  path: string;
  /** Format the bytes are encoded as — recorded on the result so the caller
   *  doesn't have to re-derive it from a file extension. */
  format: ScreenshotFormat;
  /** Whether the bytes were captured with `fullPage:true`. Recorded on the
   *  result for trace / debug visibility. */
  fullPage: boolean;
}

export interface ScreenshotSaveResult {
  ok: true;
  /** Absolute, workspace-rooted path the bytes were written to. */
  path: string;
  /** Final on-disk size, in bytes. */
  bytes: number;
  /** Format the bytes were encoded as. */
  format: ScreenshotFormat;
  /** Whether the capture was full-page (vs viewport / element-scoped). */
  fullPage: boolean;
}

/** Write screenshot bytes to a workspace-rooted path. The caller has already
 *  encoded the buffer (via Playwright `page.screenshot()` /
 *  `locator.screenshot()`); this layer resolves the path safely, ensures the
 *  parent directory exists, and writes the bytes synchronously.
 *
 *  Throws on:
 *  - `path` escaping `$BROWX_WORKSPACE` (via `resolveWorkspacePath`).
 *  - Underlying `writeFileSync` failure (re-thrown with original message). */
export function screenshotSave(
  buf: Buffer,
  workspaceRoot: string,
  args: ScreenshotSaveArgs,
): ScreenshotSaveResult {
  const resolved = resolveWorkspacePath(workspaceRoot, args.path, "screenshot");
  // Ensure parent dir exists — `resolved` is rooted in BROWX_WORKSPACE by
  // construction (resolveWorkspacePath rejects escapes); `writeFileSync`
  // fails if the dir is missing. Same pattern as `pdfSave`.
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, buf);

  let bytes = 0;
  try {
    bytes = statSync(resolved).size;
  } catch {
    /* best-effort */
  }
  // Belt-and-braces: re-run resolve to surface the absolute path (the input
  // may have been a workspace-relative path).
  const absolute = resolvePath(resolved);
  return {
    ok: true,
    path: absolute,
    bytes,
    format: args.format,
    fullPage: args.fullPage,
  };
}
