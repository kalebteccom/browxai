// `upload_file` — set files on a file `<input>` (W-R2).
//
// Setting files on a file input is a common browser-test primitive that
// otherwise forces agents into injecting `File`/`DataTransfer` via `eval_js`
// (arbitrary JS). This drives Playwright's `locator.setInputFiles()` directly.
// Gated by the off-by-default `file-io` capability — the slot reserved for
// exactly this. Works on hidden inputs (Playwright handles `display:none`).
//
// Two file sources:
//   - `content` — base64 inline; no filesystem read at all (preferred for
//     agent-generated content).
//   - `path` — resolved **inside `$BROWX_WORKSPACE` only**; a path escaping
//     the workspace is rejected, keeping the no-trace / no-arbitrary-fs-read
//     posture even with `file-io` enabled. Stage the file in the workspace.

import { resolve, sep } from "node:path";
import type { Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { locatorFor, type ActionTarget } from "./locator.js";

export interface UploadArgs {
  target: ActionTarget;
  /** filename presented to the page (content-mode; default "upload"). */
  name?: string;
  /** MIME type (content-mode; default "application/octet-stream"). */
  mimeType?: string;
  /** base64 file content. Mutually exclusive with `path`. */
  content?: string;
  /** workspace-rooted file path. Mutually exclusive with `content`. */
  path?: string;
}

export interface UploadResult {
  ok: boolean;
  mode: "content" | "path";
  name: string;
}

export async function uploadFile(
  page: Page,
  refs: RefRegistry,
  workspaceRoot: string,
  args: UploadArgs,
): Promise<UploadResult> {
  if (args.content !== undefined && args.path !== undefined) {
    throw new Error("upload_file: pass exactly one of `content` (base64) or `path`");
  }
  if (args.content === undefined && args.path === undefined) {
    throw new Error("upload_file: requires `content` (base64) or `path`");
  }
  const loc = locatorFor(page, refs, args.target);

  if (args.content !== undefined) {
    const name = args.name ?? "upload";
    await loc.setInputFiles({
      name,
      mimeType: args.mimeType ?? "application/octet-stream",
      buffer: Buffer.from(args.content, "base64"),
    });
    return { ok: true, mode: "content", name };
  }

  const resolved = resolve(workspaceRoot, args.path!);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(
      "upload_file: `path` must resolve inside $BROWX_WORKSPACE — stage the file there, or use `content` (base64)",
    );
  }
  await loc.setInputFiles(resolved);
  return { ok: true, mode: "path", name: args.path! };
}
