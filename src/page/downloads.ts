// Per-session download-capture pipeline. The reverse of `upload_file`:
// intercept Playwright `download` events, persist the artifact to a
// workspace-rooted slot, and surface it on `ActionResult.downloads[]` plus
// `download_get` for byte-level retrieval.
//
// Design notes:
//   - **Off by default.** A session's listener is always attached at creation,
//     but it only persists files when `DownloadsRegistry.captureOn` is true
//     (toggled by the `downloads_capture` MCP tool). When off the listener
//     deletes Playwright's temp artifact and records nothing — keeps the
//     no-trace posture for sessions that never opted in.
//   - **Workspace-rooted paths only.** Captured files land in
//     `$BROWX_WORKSPACE/.downloads/<sessionId>/<id>-<sanitised-name>`. The
//     suggested filename from the page is *sanitised* (no path separators, no
//     traversal, no NULs, no control bytes, length-capped) before composing the
//     on-disk name. Same posture as `upload.ts`'s workspace-escape rejection.
//   - **Per-session.** Each `SessionEntry` owns a registry; entries don't
//     cross sessions. Ids are session-local and monotonic.
//   - Gated by the existing `file-io` capability (no new capability), same as
//     `upload_file`.

import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { BrowserContext, Download } from "playwright-core";
import { log } from "../util/logging.js";

/** What lands on `ActionResult.downloads[]` and `download_get`. Workspace-rooted
 *  paths only; never absolute outside `$BROWX_WORKSPACE`. */
export interface CapturedDownload {
  /** session-local monotonic id (`d1`, `d2`, …) — pass back to `download_get`. */
  id: string;
  /** filename the page suggested (sanitised; raw value kept too). */
  suggestedFilename: string;
  /** raw page-supplied filename pre-sanitisation, only present when sanitisation
   *  changed it. Useful when an agent wants to know the original (e.g. routing
   *  decisions) but the on-disk name diverged. */
  rawSuggestedFilename?: string;
  /** best-effort MIME type. Playwright doesn't expose the HTTP `Content-Type`
   *  on `Download`, so this is filename-extension-inferred. May be undefined. */
  mimeType?: string;
  /** size of the persisted file in bytes. 0 if the file vanished before we
   *  could stat it (best-effort). */
  sizeBytes: number;
  /** absolute on-disk path, ALWAYS rooted under `$BROWX_WORKSPACE/.downloads/`. */
  path: string;
  /** epoch-ms when the download fired. */
  capturedAt: number;
}

/** Per-session download registry. One instance per SessionEntry. */
export class DownloadsRegistry {
  /** Toggled by the `downloads_capture` MCP tool. */
  captureOn = false;
  /** Active captures, keyed by id. Bounded to MAX_ENTRIES — oldest evicted. */
  private entries = new Map<string, CapturedDownload>();
  private nextId = 1;
  /** Captures that have fired and are not yet sliced into an ActionResult. */
  private pendingSince: CapturedDownload[] = [];
  /** Max captures kept in memory + on disk per session before LRU-evicting
   *  the oldest. Prevents an unbounded download loop from filling the disk. */
  private static MAX_ENTRIES = 100;

  constructor(
    /** Per-session storage dir: `$BROWX_WORKSPACE/.downloads/<sessionId>/`. */
    readonly storageDir: string,
  ) {}

  /** List all captured downloads for this session (most-recent first). */
  list(): CapturedDownload[] {
    return [...this.entries.values()].reverse();
  }

  /** Look up a capture by id; undefined if not present. */
  get(id: string): CapturedDownload | undefined {
    return this.entries.get(id);
  }

  /** Slice captures that fired after `tsMs` (action-window slice). Returns a
   *  snapshot of the captures so the action-window can include them on the
   *  ActionResult without exposing the live registry. */
  since(tsMs: number): CapturedDownload[] {
    return [...this.entries.values()].filter((d) => d.capturedAt >= tsMs);
  }

  /** Record a capture. Caller has already persisted the file at `path`. */
  record(record: Omit<CapturedDownload, "id">): CapturedDownload {
    const id = `d${this.nextId++}`;
    const entry: CapturedDownload = { id, ...record };
    this.entries.set(id, entry);
    this.pendingSince.push(entry);
    // LRU evict oldest if over the cap.
    while (this.entries.size > DownloadsRegistry.MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const victim = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (victim) {
        // unlink under the workspace-rooted storageDir (BROWX_WORKSPACE).
        try { unlinkSync(victim.path); } catch { /* best-effort cleanup */ }
      }
    }
    return entry;
  }
}

/** Sanitise a page-supplied filename for safe on-disk use. Rules (mirrors the
 *  workspace-escape posture in `upload.ts`):
 *    - strip path separators (`/`, `\`) and NUL/control bytes — collapses any
 *      traversal attempt to a flat filename.
 *    - reject leading dots so we never write to a hidden `.foo` file.
 *    - cap at 200 chars (leaves room for the `<id>-` prefix on filesystems
 *      with 255-byte name limits).
 *    - empty / all-stripped → fall back to `"download"`.
 *  Exported for unit tests. */
export function sanitiseFilename(raw: string): string {
  if (typeof raw !== "string") return "download";
  // strip NUL + control bytes (0x00-0x1f, 0x7f) and path separators.
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\x00-\x1f\x7f/\\]/g, "_");
  // collapse runs of dots ("../.." → ".") so the literal substring `..`
  // never survives — eliminates "looks-like-traversal" appearance even though
  // the lack of separators already makes traversal impossible.
  name = name.replace(/\.{2,}/g, ".");
  // collapse repeated underscores from the strip pass.
  name = name.replace(/_+/g, "_");
  // strip leading dots so we don't write a hidden file.
  name = name.replace(/^\.+/, "");
  // strip leading/trailing whitespace, dots, underscores — these only exist
  // because of the strip passes above; without them the filename "/" would
  // remain as "_" which is unhelpful + tests as if it carried information.
  name = name.replace(/^[._\s]+|[._\s]+$/g, "");
  // cap length.
  if (name.length > 200) name = name.slice(0, 200);
  if (!name) return "download";
  return name;
}

/** Best-effort MIME type from a filename extension. Tiny built-in table; this
 *  is metadata only (we never reject on it), so an unknown extension just
 *  yields `undefined`. */
export function mimeTypeFromName(name: string): string | undefined {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  if (!m) return undefined;
  const ext = m[1]!.toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    txt: "text/plain",
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    webm: "video/webm",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
  };
  return map[ext];
}

/** Attach the Playwright `download` listener to a context. The listener fires
 *  for every download on every page in the context (now or later). When
 *  capture is OFF the artifact is silently deleted; when ON it's persisted and
 *  the registry records it. Errors during capture never propagate — they
 *  surface as warnings on the session's log only. */
export function attachDownloadCapture(
  context: BrowserContext,
  registry: DownloadsRegistry,
): void {
  context.on("download", (download) => {
    void handleDownload(download, registry).catch((err) => {
      log.warn("downloads: capture failed", { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handleDownload(download: Download, registry: DownloadsRegistry): Promise<void> {
  if (!registry.captureOn) {
    // Capture disabled for this session: discard the artifact and record
    // nothing. Playwright still buffers downloads to a temp file when
    // `acceptDownloads: true`; cancelling drops the temp file.
    await download.cancel().catch(() => undefined);
    return;
  }
  const raw = download.suggestedFilename() ?? "download";
  const safe = sanitiseFilename(raw);
  // Ensure storage dir exists (created lazily; sessions that never opt in
  // never create it). The dir is workspace-rooted (BROWX_WORKSPACE/.downloads
  // via the SessionEntry factory in server.ts — never cwd).
  mkdirSync(registry.storageDir, { recursive: true });
  // Compose final on-disk path. We can't know the id yet (registry assigns
  // it on `record`); use a millisecond+random prefix to disambiguate
  // simultaneous downloads, then we'll record once persisted.
  const prefix = `${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const target = join(registry.storageDir, `${prefix}-${safe}`);
  // Reject any composed path that doesn't resolve INSIDE storageDir. Defence
  // in depth — sanitiseFilename already strips separators, but if a future
  // change loosens it the workspace-escape guard catches it.
  const resolved = resolve(target);
  const root = resolve(registry.storageDir);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    await download.cancel().catch(() => undefined);
    log.warn("downloads: refusing to persist outside storage dir", { resolved, root });
    return;
  }
  try {
    await download.saveAs(resolved);
  } catch (err) {
    log.warn("downloads: saveAs failed", { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let sizeBytes = 0;
  try { sizeBytes = statSync(resolved).size; } catch { /* best-effort */ }
  const rawDifferedFromSafe = raw !== safe;
  registry.record({
    suggestedFilename: safe,
    ...(rawDifferedFromSafe ? { rawSuggestedFilename: raw } : {}),
    mimeType: mimeTypeFromName(safe),
    sizeBytes,
    path: resolved,
    capturedAt: Date.now(),
  });
}

/** Read a captured download's bytes. Returns base64. Throws if the id is
 *  unknown or the file vanished. */
export function readCapturedBytes(reg: DownloadsRegistry, id: string): { base64: string; bytes: number; path: string; mimeType?: string; suggestedFilename: string } {
  const entry = reg.get(id);
  if (!entry) {
    throw new Error(`download_get: unknown id "${id}". Call downloads_capture({on:true}) before the action that triggers the download, then read the id from ActionResult.downloads[]`);
  }
  let buf: Buffer;
  try {
    buf = readFileSync(entry.path);
  } catch (err) {
    throw new Error(`download_get: file vanished for id "${id}" at ${entry.path} (${err instanceof Error ? err.message : String(err)})`);
  }
  return {
    base64: buf.toString("base64"),
    bytes: buf.length,
    path: entry.path,
    mimeType: entry.mimeType,
    suggestedFilename: entry.suggestedFilename,
  };
}
