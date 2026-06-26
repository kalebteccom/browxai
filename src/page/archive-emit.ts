// page_archive emission strategies — the two ways a fetched archive lands on
// disk. Split out of archive.ts so the orchestrator (pageArchive + discovery +
// fetch phase) stays focused on collecting bytes; this file owns turning the
// collected bytes into files. Behavior-identical to the in-archive.ts originals.
//
//   - `emitArchiveDirectory` — write `index.html` + an `assets/<kind>/` sidecar,
//     rewriting the HTML to relative paths.
//   - `emitArchiveSingleFile` — inline every asset as a `data:` URI into one
//     self-contained HTML file.
//
// Both are workspace-rooted by construction: the `resolved` path was already
// gated through `resolveWorkspacePath` upstream, so writing under it (or its
// parent) cannot escape $BROWX_WORKSPACE.

import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import {
  assetFilename,
  subdirForKind,
  rewriteHtml,
  mimeFromKind,
  directorySize,
  type Fetched,
  type ArchiveEmitResult,
} from "./archive-assets.js";

/** Hard ceiling for single-file mode beyond the user's cap. Browsers
 *  routinely struggle to load HTML > ~150 MB into a single document — the
 *  in-memory `data:` URI cost compounds. We surface a warning when the
 *  single-file output exceeds this, but never refuse: the cap is the cap. */
export const SINGLE_FILE_SOFT_WARN_MB = 150;

/** Emit the multi-file directory archive — each asset under `assets/<kind>/`,
 *  the HTML rewritten to relative paths. Workspace-rooted by construction
 *  (`resolved` ⊆ $BROWX_WORKSPACE). */
export function emitArchiveDirectory(
  resolved: string,
  html: string,
  fetched: Fetched[],
  runningBytes: number,
): ArchiveEmitResult {
  mkdirSync(resolved, { recursive: true });
  const assetsRoot = join(resolved, "assets");
  mkdirSync(assetsRoot, { recursive: true });
  let resourceCount = 0;
  let droppedCount = 0;
  const replacements: Array<{ rawRef: string; replacement: string }> = [];
  for (const f of fetched) {
    if (!f.r.ok || !f.r.base64) {
      droppedCount++;
      continue;
    }
    const subdir = subdirForKind(f.res.kind);
    const dir = join(assetsRoot, subdir);
    mkdirSync(dir, { recursive: true });
    const filename = assetFilename(f.res.url, f.res.kind, f.r.contentType ?? "");
    writeFileSync(join(dir, filename), Buffer.from(f.r.base64, "base64"));
    replacements.push({ rawRef: f.res.rawRef, replacement: `assets/${subdir}/${filename}` });
    resourceCount++;
  }
  const rewritten = rewriteHtml(html, replacements);
  // workspace-rooted: `resolved` ⊆ $BROWX_WORKSPACE (resolveWorkspacePath gated it).
  writeFileSync(join(resolved, "index.html"), rewritten, "utf8");
  let sizeBytes: number;
  try {
    sizeBytes = directorySize(resolved);
  } catch {
    sizeBytes = Buffer.byteLength(rewritten, "utf8") + runningBytes;
  }
  return { resourceCount, droppedCount, sizeBytes };
}

/** Emit the single-file archive — assets inlined as data: URIs in the HTML.
 *  Workspace-rooted by construction (`resolved` ⊆ $BROWX_WORKSPACE). */
export function emitArchiveSingleFile(
  resolved: string,
  html: string,
  fetched: Fetched[],
  warnings: string[],
): ArchiveEmitResult {
  // workspace-rooted: dirname(resolved) is the parent of a $BROWX_WORKSPACE path.
  mkdirSync(dirname(resolved), { recursive: true });
  let resourceCount = 0;
  let droppedCount = 0;
  const replacements: Array<{ rawRef: string; replacement: string }> = [];
  for (const f of fetched) {
    if (!f.r.ok || !f.r.base64) {
      droppedCount++;
      continue;
    }
    const mime = (f.r.contentType ?? "").split(";")[0]!.trim() || mimeFromKind(f.res.kind);
    replacements.push({ rawRef: f.res.rawRef, replacement: `data:${mime};base64,${f.r.base64}` });
    resourceCount++;
  }
  const rewritten = rewriteHtml(html, replacements);
  // workspace-rooted: `resolved` ⊆ $BROWX_WORKSPACE (resolveWorkspacePath gated it).
  writeFileSync(resolved, rewritten, "utf8");
  const sizeBytes = statSync(resolved).size;
  if (sizeBytes > SINGLE_FILE_SOFT_WARN_MB * 1024 * 1024) {
    warnings.push(
      `single-file archive is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. ` +
        `Browsers commonly struggle to open inline-data HTML beyond ~${SINGLE_FILE_SOFT_WARN_MB} MB ` +
        '(the data: URI cost compounds in-memory). Use `format:"directory"` for large pages.',
    );
  }
  return { resourceCount, droppedCount, sizeBytes };
}
