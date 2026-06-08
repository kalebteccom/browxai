// `asset_export` — filter the session's network ring and persist matching
// responses to a workspace-rooted directory.
//
// Design posture (mirrors `downloads.ts`):
//   - **Workspace-rooted paths only.** Exports land under
//     `$BROWX_WORKSPACE/assets/<sessionId>-<ISO>/` by default; an explicit
//     `intoDir` is resolved INSIDE the workspace (escape rejected).
//   - **Filename sanitisation** is the same posture as `downloads.sanitiseFilename`
//     — no path separators, no NUL/control bytes, no leading dots, length-capped,
//     all-stripped names fall back to `"asset"`. Collisions are resolved by
//     appending `-N` to the stem so a second `logo.png` becomes `logo-1.png`.
//   - **Bounded.** Caller can raise `maxCount` / `maxBytes` but never above a
//     hard ceiling — a misconfigured filter on a long-running session must not
//     fill the workspace. Defaults: 10000 files / 500 MiB.
//   - **CORS tolerance.** When the response body isn't in the renderer's cache
//     (CDP `Network.getResponseBody` returns "not available" — bodies are
//     short-lived) we fall back to a same-origin in-page `fetch()` for the
//     original URL. Cross-origin URLs without CORS headers may reject; we record
//     the failure on `droppedCount` and keep going.
//   - **No new capability.** Reuses `file-io` (same as `upload_file` /
//     `downloads_capture` / `download_get`).

import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import type { CDPSession, Page } from "playwright-core";
import type { NetworkBuffer, NetworkEntry } from "./network.js";
import { log } from "../util/logging.js";

// ---------- caps & defaults --------------------------------------------------

/** Hard ceiling on the per-call file count cap — even a caller-supplied
 *  `maxCount` is clamped to this. Bounds a runaway export on a long session. */
export const ASSET_EXPORT_HARD_MAX_COUNT = 50_000;
/** Hard ceiling on the per-call byte cap. */
export const ASSET_EXPORT_HARD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Default per-call file count cap. Caller can override up to the hard max. */
export const ASSET_EXPORT_DEFAULT_MAX_COUNT = 10_000;
/** Default per-call byte cap (500 MiB). */
export const ASSET_EXPORT_DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

/** Maximum bytes for a single response body — same posture as
 *  `fetchResponseBody`'s default. Larger responses are skipped with a
 *  warning so one huge video can't blow the whole export. */
const SINGLE_BODY_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Cap on the on-disk filename length, accounting for the `-N` collision
 *  suffix room and 255-byte filesystem name limits. */
const FILENAME_MAX_CHARS = 200;

// ---------- input / output shapes -------------------------------------------

export interface AssetFilter {
  /** Substring match against response `Content-Type` (case-insensitive,
   *  any one match wins). Example: `["image/", "video/"]`. Undefined → any. */
  mime?: string[];
  /** RegExp source; matched case-insensitive against the response URL.
   *  Example: `"\\.(woff2?|ttf|otf)$"`. Invalid regex → throws at the tool
   *  boundary so the agent sees the structured error. */
  urlPattern?: string;
  /** Inclusive lower bound on the response's encoded byte size. */
  minBytes?: number;
  /** Inclusive upper bound on the response's encoded byte size. */
  maxBytes?: number;
  /** Allow-list of HTTP status codes. Default: 2xx (200..299). */
  status?: number[];
}

export interface ManifestEntry {
  url: string;
  mime?: string;
  status?: number;
  sizeBytes: number;
  savedAs: string;
}

export interface AssetExportResult {
  ok: boolean;
  intoDir: string;
  totalCount: number;
  matchedCount: number;
  persistedCount: number;
  droppedCount: number;
  manifest: ManifestEntry[];
  warnings: string[];
}

export interface AssetExportArgs {
  filter: AssetFilter;
  /** Workspace-rooted subdir for the exported files. Default
   *  `assets/<sessionId>-<ISO>/`. Escape rejected. */
  intoDir?: string;
  /** Override the per-call file count cap. Clamped to
   *  `ASSET_EXPORT_HARD_MAX_COUNT`. */
  maxCount?: number;
  /** Override the per-call total byte cap. Clamped to
   *  `ASSET_EXPORT_HARD_MAX_BYTES`. */
  maxBytes?: number;
}

// ---------- pure helpers (exported for unit tests) ---------------------------

/** Build the regex once at the boundary. Throws `Error` on invalid source so
 *  the tool layer surfaces a structured failure instead of a runtime crash
 *  deep inside the loop. */
export function compileUrlPattern(src: string | undefined): RegExp | null {
  if (!src) return null;
  try {
    return new RegExp(src, "i");
  } catch (err) {
    throw new Error(
      `asset_export: invalid \`filter.urlPattern\` — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Filter a single `NetworkEntry` against a normalised filter. Pure — uses
 *  only the entry's captured metadata; no I/O. Exported so the test suite
 *  can pin every branch without spinning a NetworkBuffer. */
export function matchesFilter(
  entry: NetworkEntry,
  filter: { mime?: string[]; urlPattern: RegExp | null; minBytes?: number; maxBytes?: number; status: ReadonlySet<number> | null },
): boolean {
  // Status: defaults to "2xx" when caller didn't supply an allow-list.
  if (filter.status) {
    if (entry.status === undefined || !filter.status.has(entry.status)) return false;
  } else {
    if (entry.status === undefined || entry.status < 200 || entry.status >= 300) return false;
  }
  // MIME: substring on the captured Content-Type. No mime info → reject; the
  // export contract is "filter by mime", an entry that never reported a
  // Content-Type can't be classified.
  if (filter.mime && filter.mime.length > 0) {
    if (!entry.mimeType) return false;
    const lower = entry.mimeType.toLowerCase();
    if (!filter.mime.some((m) => lower.includes(m.toLowerCase()))) return false;
  }
  // URL pattern: case-insensitive regex.
  if (filter.urlPattern && !filter.urlPattern.test(entry.url)) return false;
  // Byte bounds: only enforced when bytes have landed. A still-in-flight
  // entry without a finished size is admitted at the filter step; the
  // body-fetch step counts its actual bytes against the total cap.
  if (typeof filter.minBytes === "number" && typeof entry.bytes === "number" && entry.bytes < filter.minBytes) return false;
  if (typeof filter.maxBytes === "number" && typeof entry.bytes === "number" && entry.bytes > filter.maxBytes) return false;
  return true;
}

/** Sanitise a URL-derived asset filename. Same posture as
 *  `downloads.sanitiseFilename`:
 *    - strip path separators (`/`, `\`) and NUL/control bytes — collapses any
 *      traversal attempt to a flat filename.
 *    - collapse runs of dots so the literal `..` substring never survives.
 *    - strip leading dots so we don't write a hidden file.
 *    - cap length (leaves room for a `-N` collision suffix).
 *    - empty / all-stripped → fall back to `"asset"`.
 *  Exported for unit tests. */
export function sanitiseAssetFilename(raw: string): string {
  if (typeof raw !== "string") return "asset";
  // strip NUL + control bytes (0x00-0x1f, 0x7f) and path separators.
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\x00-\x1f\x7f/\\]/g, "_");
  // collapse runs of dots ("../.." → ".") so the literal substring `..`
  // never survives — eliminates "looks-like-traversal" even though the
  // lack of separators already makes traversal impossible.
  name = name.replace(/\.{2,}/g, ".");
  // collapse repeated underscores from the strip pass.
  name = name.replace(/_+/g, "_");
  // strip leading dots so we don't write a hidden file.
  name = name.replace(/^\.+/, "");
  // strip leading/trailing whitespace, dots, underscores — these only exist
  // because of the strip passes above.
  name = name.replace(/^[._\s]+|[._\s]+$/g, "");
  if (name.length > FILENAME_MAX_CHARS) name = name.slice(0, FILENAME_MAX_CHARS);
  if (!name) return "asset";
  return name;
}

/** Derive a base filename from a URL: take the last path segment, decode
 *  percent-encoding, drop a query string. Falls back to `"asset"` when the
 *  URL has no usable basename (e.g. `https://example.com/`). Exported for
 *  unit tests. */
export function filenameFromUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  // basename strips the trailing slash; pathname like `/` → `""`.
  let base = basename(pathname);
  if (!base) base = "asset";
  try {
    base = decodeURIComponent(base);
  } catch {
    // malformed percent-encoding — keep the raw form, sanitisation handles it.
  }
  return sanitiseAssetFilename(base);
}

/** Resolve a collision by appending `-N` before the extension. Pure; uses
 *  the supplied `Set` of already-used names. Exported for unit tests. */
export function resolveCollision(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1_000_000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
  // 1M collisions on the same stem is effectively impossible; if it happens,
  // disambiguate with the current timestamp + a random tail.
  return `${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

/** ISO-8601 timestamp safe for use in a directory name (`:` replaced with `-`). */
export function timestampForDir(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

// ---------- workspace path safety -------------------------------------------

/** Resolve the export dir. Default: `assets/<sessionId>-<ISO>/`. Caller-
 *  supplied `intoDir` is resolved INSIDE `workspaceRoot`; any escape throws
 *  the same structured error as `upload_file` / `pdf_save`. */
export function resolveAssetExportDir(
  workspaceRoot: string,
  sessionId: string,
  intoDir?: string,
): string {
  const rel = intoDir ?? `assets/${sessionId}-${timestampForDir()}`;
  const resolved = resolve(workspaceRoot, rel);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(
      `asset_export: \`intoDir\` must resolve inside $BROWX_WORKSPACE — got "${rel}". ` +
      `Use a workspace-relative path.`,
    );
  }
  return resolved;
}

// ---------- body fetch -------------------------------------------------------

/** Try CDP `Network.getResponseBody` first; on "not available" fall back to
 *  an in-page `fetch()` against the original URL. Returns the bytes (decoded)
 *  + the effective content-type, or an `{ error }` envelope when both attempts
 *  fail. The CORS caveat: cross-origin URLs without permissive CORS headers
 *  will reject the in-page fetch; that's surfaced as `droppedCount` by the
 *  caller, not a crash. */
export async function fetchBodyBytes(
  cdp: CDPSession,
  page: Page,
  entry: NetworkEntry,
): Promise<{ ok: true; bytes: Buffer; mimeType?: string } | { ok: false; error: string }> {
  // First try the renderer's cached body — short-lived but free.
  if (entry.requestId) {
    try {
      const { body, base64Encoded } = (await cdp.send("Network.getResponseBody", {
        requestId: entry.requestId,
      })) as { body: string; base64Encoded: boolean };
      const buf = base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body, "utf8");
      const out: { ok: true; bytes: Buffer; mimeType?: string } = { ok: true, bytes: buf };
      if (entry.mimeType !== undefined) out.mimeType = entry.mimeType;
      return out;
    } catch {
      // body discarded by the renderer — fall through to the in-page fetch.
    }
  }
  // Fallback: in-page `fetch()`. CORS caveat — cross-origin URLs without
  // permissive headers will throw; we report it as a drop, not a crash.
  try {
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const arr = new Uint8Array(buf);
        // Encode as base64 inside the page so the bridge marshalling is
        // string-only (avoids the structured-clone size cliff on big buffers).
        let bin = "";
        const chunk = 0x8000;
        for (let i = 0; i < arr.length; i += chunk) {
          bin += String.fromCharCode(...arr.subarray(i, Math.min(i + chunk, arr.length)));
        }
        return {
          ok: true as const,
          base64: btoa(bin),
          mimeType: res.headers.get("content-type") ?? undefined,
        };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    }, entry.url);
    if (!result.ok) return { ok: false, error: `in-page fetch failed: ${result.error}` };
    const out: { ok: true; bytes: Buffer; mimeType?: string } = {
      ok: true,
      bytes: Buffer.from(result.base64, "base64"),
    };
    const mt = result.mimeType ?? entry.mimeType;
    if (mt !== undefined) out.mimeType = mt;
    return out;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- main entry point -------------------------------------------------

export async function assetExport(
  cdp: CDPSession,
  page: Page,
  buffer: NetworkBuffer,
  workspaceRoot: string,
  sessionId: string,
  args: AssetExportArgs,
): Promise<AssetExportResult> {
  const filter = args.filter ?? {};
  const urlPattern = compileUrlPattern(filter.urlPattern);
  const statusSet = filter.status && filter.status.length > 0 ? new Set(filter.status) : null;
  const maxCount = Math.min(
    Math.max(1, args.maxCount ?? ASSET_EXPORT_DEFAULT_MAX_COUNT),
    ASSET_EXPORT_HARD_MAX_COUNT,
  );
  const maxBytes = Math.min(
    Math.max(1, args.maxBytes ?? ASSET_EXPORT_DEFAULT_MAX_BYTES),
    ASSET_EXPORT_HARD_MAX_BYTES,
  );

  const intoDir = resolveAssetExportDir(workspaceRoot, sessionId, args.intoDir);
  // `intoDir` is workspace-rooted by construction: `resolveAssetExportDir`
  // resolves it inside `workspaceRoot` ($BROWX_WORKSPACE) and rejects any
  // escape. Every write below is under this dir, never cwd.
  mkdirSync(intoDir, { recursive: true });

  const all = buffer.iter();
  const totalCount = all.length;
  const warnings: string[] = [];
  const manifest: ManifestEntry[] = [];
  const used = new Set<string>();
  let matchedCount = 0;
  let droppedCount = 0;
  let runningBytes = 0;

  for (const entry of all) {
    if (!matchesFilter(entry, { mime: filter.mime, urlPattern, minBytes: filter.minBytes, maxBytes: filter.maxBytes, status: statusSet })) {
      continue;
    }
    matchedCount += 1;

    if (manifest.length >= maxCount) {
      warnings.push(
        `maxCount (${maxCount}) reached — ${matchedCount - manifest.length} additional matches were not persisted`,
      );
      break;
    }
    if (typeof entry.bytes === "number" && entry.bytes > SINGLE_BODY_MAX_BYTES) {
      droppedCount += 1;
      warnings.push(
        `skipped ${entry.url} — single-response size (${entry.bytes} bytes) exceeds SINGLE_BODY_MAX_BYTES (${SINGLE_BODY_MAX_BYTES})`,
      );
      continue;
    }
    const fetched = await fetchBodyBytes(cdp, page, entry);
    if (!fetched.ok) {
      droppedCount += 1;
      warnings.push(`skipped ${entry.url} — ${fetched.error}`);
      continue;
    }
    if (fetched.bytes.length > SINGLE_BODY_MAX_BYTES) {
      droppedCount += 1;
      warnings.push(
        `skipped ${entry.url} — fetched body (${fetched.bytes.length} bytes) exceeds SINGLE_BODY_MAX_BYTES (${SINGLE_BODY_MAX_BYTES})`,
      );
      continue;
    }
    if (runningBytes + fetched.bytes.length > maxBytes) {
      warnings.push(
        `maxBytes (${maxBytes}) would be exceeded by ${entry.url} (${fetched.bytes.length} bytes); stopping export`,
      );
      break;
    }
    const baseName = filenameFromUrl(entry.url);
    const finalName = resolveCollision(baseName, used);
    used.add(finalName);
    const target = join(intoDir, finalName);
    // Defence in depth — the sanitised name has no separators, so the join
    // can't escape `intoDir`. Still verify.
    const resolved = resolve(target);
    if (resolved !== intoDir && !resolved.startsWith(intoDir + sep)) {
      droppedCount += 1;
      warnings.push(`refused to write outside intoDir: ${entry.url}`);
      continue;
    }
    try {
      // `resolved` lands under `intoDir` (workspace-rooted by construction);
      // the workspace-escape verify above guarantees the path stays inside
      // $BROWX_WORKSPACE.
      writeFileSync(resolved, fetched.bytes);
    } catch (err) {
      droppedCount += 1;
      warnings.push(`write failed for ${entry.url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let sizeBytes = fetched.bytes.length;
    try { sizeBytes = statSync(resolved).size; } catch { /* best-effort */ }
    runningBytes += sizeBytes;
    const m: ManifestEntry = {
      url: entry.url,
      sizeBytes,
      savedAs: finalName,
    };
    const mt = fetched.mimeType ?? entry.mimeType;
    if (mt !== undefined) m.mime = mt;
    if (entry.status !== undefined) m.status = entry.status;
    manifest.push(m);
  }

  // Write `_manifest.json` last so a crash mid-export doesn't leave a
  // misleading manifest pointing at files that weren't all written.
  // `intoDir` is workspace-rooted ($BROWX_WORKSPACE / workspaceRoot) by
  // construction — see `resolveAssetExportDir` above.
  try {
    const manifestPath = join(intoDir, "_manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ intoDir, manifest }, null, 2));
  } catch (err) {
    log.warn("asset_export: writing _manifest.json failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    warnings.push(`writing _manifest.json failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    ok: true,
    intoDir,
    totalCount,
    matchedCount,
    persistedCount: manifest.length,
    droppedCount,
    manifest,
    warnings,
  };
}
