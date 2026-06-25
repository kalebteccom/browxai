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
import { join, resolve, sep } from "node:path";
import type { CDPSession, Page } from "playwright-core";
import type { SessionNetworkRing, NetworkEntry } from "./network.js";
import { log } from "../util/logging.js";
import { filenameFromUrl, resolveCollision, timestampForDir } from "./asset-export-naming.js";

// Re-export the engine-blind naming helpers so the original import path stays
// the public surface — colocated tests import these from here.
export {
  filenameFromUrl,
  resolveCollision,
  sanitiseAssetFilename,
  timestampForDir,
} from "./asset-export-naming.js";

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
interface NormalisedAssetFilter {
  mime?: string[];
  urlPattern: RegExp | null;
  minBytes?: number;
  maxBytes?: number;
  status: ReadonlySet<number> | null;
}

/** Status gate: an explicit allow-list, else default 2xx. */
function statusMatches(entry: NetworkEntry, status: ReadonlySet<number> | null): boolean {
  if (entry.status === undefined) return false;
  return status ? status.has(entry.status) : entry.status >= 200 && entry.status < 300;
}

/** MIME gate: substring on the captured Content-Type; no mime info → reject
 *  (an entry that never reported a Content-Type can't be classified). */
function mimeMatches(entry: NetworkEntry, mime: string[] | undefined): boolean {
  if (!mime || mime.length === 0) return true;
  if (!entry.mimeType) return false;
  const lower = entry.mimeType.toLowerCase();
  return mime.some((m) => lower.includes(m.toLowerCase()));
}

/** Byte-bound gate: only enforced when bytes have landed (still-in-flight
 *  entries are admitted here; the fetch step counts actual bytes). */
function bytesMatch(entry: NetworkEntry, minBytes?: number, maxBytes?: number): boolean {
  if (typeof entry.bytes !== "number") return true;
  if (typeof minBytes === "number" && entry.bytes < minBytes) return false;
  if (typeof maxBytes === "number" && entry.bytes > maxBytes) return false;
  return true;
}

/** Filter a single `NetworkEntry` against a normalised filter. Pure — uses only
 *  the entry's captured metadata; no I/O. Exported so the test suite can pin
 *  every branch without spinning a NetworkBuffer. */
export function matchesFilter(entry: NetworkEntry, filter: NormalisedAssetFilter): boolean {
  if (!statusMatches(entry, filter.status)) return false;
  if (!mimeMatches(entry, filter.mime)) return false;
  if (filter.urlPattern && !filter.urlPattern.test(entry.url)) return false;
  return bytesMatch(entry, filter.minBytes, filter.maxBytes);
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
      const { body, base64Encoded } = await cdp.send("Network.getResponseBody", {
        requestId: entry.requestId,
      });
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

/** The live-session handles + workspace anchors `asset_export` threads through,
 *  bundled so the entry point stays within the parameter budget. */
export interface AssetExportDeps {
  cdp: CDPSession;
  page: Page;
  buffer: SessionNetworkRing;
  workspaceRoot: string;
  sessionId: string;
}

/** The mutable export accumulator threaded through the per-entry loop. */
interface ExportState {
  intoDir: string;
  maxCount: number;
  maxBytes: number;
  warnings: string[];
  manifest: ManifestEntry[];
  used: Set<string>;
  matchedCount: number;
  droppedCount: number;
  runningBytes: number;
}

type EntryDisposition = "continue" | "break";

/** Persist one fetched body to disk, appending its manifest entry (or recording
 *  a drop / workspace-escape refusal). Returns "break" only on a maxBytes stop. */
function persistAssetBody(
  st: ExportState,
  entry: NetworkEntry,
  fetched: { bytes: Buffer; mimeType?: string },
): EntryDisposition {
  if (st.runningBytes + fetched.bytes.length > st.maxBytes) {
    st.warnings.push(
      `maxBytes (${st.maxBytes}) would be exceeded by ${entry.url} (${fetched.bytes.length} bytes); stopping export`,
    );
    return "break";
  }
  const finalName = resolveCollision(filenameFromUrl(entry.url), st.used);
  st.used.add(finalName);
  // Defence in depth — the sanitised name has no separators, so the join can't
  // escape `intoDir`; verify anyway ($BROWX_WORKSPACE-rooted by construction).
  const resolved = resolve(join(st.intoDir, finalName));
  if (resolved !== st.intoDir && !resolved.startsWith(st.intoDir + sep)) {
    st.droppedCount += 1;
    st.warnings.push(`refused to write outside intoDir: ${entry.url}`);
    return "continue";
  }
  try {
    writeFileSync(resolved, fetched.bytes);
  } catch (err) {
    st.droppedCount += 1;
    st.warnings.push(
      `write failed for ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "continue";
  }
  let sizeBytes = fetched.bytes.length;
  try {
    sizeBytes = statSync(resolved).size;
  } catch {
    /* best-effort */
  }
  st.runningBytes += sizeBytes;
  const m: ManifestEntry = { url: entry.url, sizeBytes, savedAs: finalName };
  const mt = fetched.mimeType ?? entry.mimeType;
  if (mt !== undefined) m.mime = mt;
  if (entry.status !== undefined) m.status = entry.status;
  st.manifest.push(m);
  return "continue";
}

/** Process one matched entry: cap checks → fetch → size checks → persist. */
async function processAssetEntry(
  deps: AssetExportDeps,
  st: ExportState,
  entry: NetworkEntry,
): Promise<EntryDisposition> {
  st.matchedCount += 1;
  if (st.manifest.length >= st.maxCount) {
    st.warnings.push(
      `maxCount (${st.maxCount}) reached — ${st.matchedCount - st.manifest.length} additional matches were not persisted`,
    );
    return "break";
  }
  if (typeof entry.bytes === "number" && entry.bytes > SINGLE_BODY_MAX_BYTES) {
    st.droppedCount += 1;
    st.warnings.push(
      `skipped ${entry.url} — single-response size (${entry.bytes} bytes) exceeds SINGLE_BODY_MAX_BYTES (${SINGLE_BODY_MAX_BYTES})`,
    );
    return "continue";
  }
  const fetched = await fetchBodyBytes(deps.cdp, deps.page, entry);
  if (!fetched.ok) {
    st.droppedCount += 1;
    st.warnings.push(`skipped ${entry.url} — ${fetched.error}`);
    return "continue";
  }
  if (fetched.bytes.length > SINGLE_BODY_MAX_BYTES) {
    st.droppedCount += 1;
    st.warnings.push(
      `skipped ${entry.url} — fetched body (${fetched.bytes.length} bytes) exceeds SINGLE_BODY_MAX_BYTES (${SINGLE_BODY_MAX_BYTES})`,
    );
    return "continue";
  }
  return persistAssetBody(st, entry, fetched);
}

export async function assetExport(
  deps: AssetExportDeps,
  args: AssetExportArgs,
): Promise<AssetExportResult> {
  const filter = args.filter ?? {};
  const urlPattern = compileUrlPattern(filter.urlPattern);
  const statusSet = filter.status && filter.status.length > 0 ? new Set(filter.status) : null;
  const intoDir = resolveAssetExportDir(deps.workspaceRoot, deps.sessionId, args.intoDir);
  // `intoDir` is workspace-rooted by construction: `resolveAssetExportDir`
  // resolves it inside `workspaceRoot` ($BROWX_WORKSPACE) and rejects any escape.
  // Every write below is under this dir, never cwd.
  mkdirSync(intoDir, { recursive: true });

  const all = deps.buffer.iter();
  const totalCount = all.length;
  const st: ExportState = {
    intoDir,
    maxCount: Math.min(
      Math.max(1, args.maxCount ?? ASSET_EXPORT_DEFAULT_MAX_COUNT),
      ASSET_EXPORT_HARD_MAX_COUNT,
    ),
    maxBytes: Math.min(
      Math.max(1, args.maxBytes ?? ASSET_EXPORT_DEFAULT_MAX_BYTES),
      ASSET_EXPORT_HARD_MAX_BYTES,
    ),
    warnings: [],
    manifest: [],
    used: new Set<string>(),
    matchedCount: 0,
    droppedCount: 0,
    runningBytes: 0,
  };

  for (const entry of all) {
    const matched = matchesFilter(entry, {
      mime: filter.mime,
      urlPattern,
      minBytes: filter.minBytes,
      maxBytes: filter.maxBytes,
      status: statusSet,
    });
    if (!matched) continue;
    if ((await processAssetEntry(deps, st, entry)) === "break") break;
  }
  const { warnings, manifest, matchedCount, droppedCount } = st;

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
    warnings.push(
      `writing _manifest.json failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
