// page_archive asset helpers — the per-URL page-side fetch script, the
// filename/mime/ext/subdir naming, HTML rewriting, and directory-size walk.
// Split out of archive.ts so the orchestrator stays under the size budget;
// behavior-identical.

import { extname, sep } from "node:path";
import { statSync, readdirSync } from "node:fs";

/** One linked resource the discovery script found. `kind` drives subdir
 *  placement in directory mode + content-type inference in single-file mode. */
export interface DiscoveredResource {
  url: string;
  kind: "image" | "font" | "script" | "stylesheet" | "media" | "other";
  /** Original attribute text the discovery script saw — used to rewrite the
   *  HTML to point at the asset sidecar in directory mode. */
  rawRef: string;
}

/** Fetch one URL from inside the page, returning base64 + a content-type
 *  guess. Used in single-file mode (data: URIs) and as the byte source for
 *  directory mode. Failures are caught — the caller drops + counts. */
export function buildFetchScript(url: string): string {
  // page.evaluate(string) treats the string as an expression — `await` only
  // works inside an async IIFE. Encode the URL once at compose time.
  const literal = JSON.stringify(url);
  return `(async () => {
  try {
    var r = await fetch(${literal}, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return { ok: false, status: r.status, contentType: r.headers.get('content-type') || '' };
    var ct = r.headers.get('content-type') || '';
    var buf = await r.arrayBuffer();
    var bytes = new Uint8Array(buf);
    // chunked base64 — TextDecoder + btoa for portability inside the page
    var CHUNK = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return { ok: true, base64: btoa(parts.join('')), contentType: ct, bytes: bytes.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
})()`;
}

export interface FetchedResource {
  ok: boolean;
  base64?: string;
  contentType?: string;
  bytes?: number;
  status?: number;
  error?: string;
}

/** One discovered resource paired with its fetch outcome. Shared by the fetch
 *  phase (archive.ts) and the emission strategies (archive-emit.ts); it lives
 *  here in the leaf so neither importer has to import back through the
 *  archive.ts barrel (no cycle). */
export type Fetched = { res: DiscoveredResource; r: FetchedResource };

/** Outcome of one emission strategy — what the directory / single-file writers
 *  report back to `pageArchive` for the result envelope. */
export interface ArchiveEmitResult {
  resourceCount: number;
  droppedCount: number;
  sizeBytes: number;
}

/** Slugify a URL into a filesystem-safe asset filename. The hash prefix
 *  disambiguates same-name resources from different origins. */
export function assetFilename(
  url: string,
  kind: DiscoveredResource["kind"],
  contentType: string,
): string {
  let stem: string;
  let urlExt = "";
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "asset";
    urlExt = extname(last);
    stem = last.replace(/[^A-Za-z0-9._-]/g, "_") || "asset";
    if (urlExt) stem = stem.slice(0, -urlExt.length);
  } catch {
    stem = "asset";
  }
  // 8-char hash from the URL to disambiguate collisions across origins.
  const hash = simpleHash(url);
  const ext = urlExt || guessExtFromContentType(contentType) || guessExtFromKind(kind);
  return `${stem}-${hash}${ext}`;
}

function simpleHash(s: string): string {
  // tiny non-cryptographic hash — collision risk is negligible at archive
  // resource counts (low hundreds) and we want zero deps.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function guessExtFromContentType(ct: string): string {
  const c = ct.split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "text/html": ".html",
    "text/css": ".css",
    "text/javascript": ".js",
    "application/javascript": ".js",
    "application/json": ".json",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "image/x-icon": ".ico",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
    "application/font-woff": ".woff",
    "application/font-woff2": ".woff2",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
  };
  return map[c] ?? "";
}

function guessExtFromKind(kind: DiscoveredResource["kind"]): string {
  switch (kind) {
    case "image":
      return ".bin";
    case "font":
      return ".font";
    case "script":
      return ".js";
    case "stylesheet":
      return ".css";
    case "media":
      return ".media";
    default:
      return ".bin";
  }
}

export function subdirForKind(kind: DiscoveredResource["kind"]): string {
  switch (kind) {
    case "image":
      return "images";
    case "font":
      return "fonts";
    case "script":
      return "scripts";
    case "stylesheet":
      return "styles";
    case "media":
      return "media";
    default:
      return "other";
  }
}

/** Rewrite raw HTML — replace every recorded `rawRef` with the relative
 *  asset path the file has been written to. We do a literal substring
 *  replacement (anchored to quote boundaries where possible) rather than
 *  parsing the HTML: parsing introduces fidelity risk, and the discovery
 *  script captured exactly the raw attribute text we'll see in `outerHTML`.
 *
 *  The order matters — replace longer `rawRef`s before shorter ones so a
 *  prefix-substring of a different URL isn't accidentally matched. */
export function rewriteHtml(
  html: string,
  replacements: Array<{ rawRef: string; replacement: string }>,
): string {
  const sorted = [...replacements].sort((a, b) => b.rawRef.length - a.rawRef.length);
  let out = html;
  for (const { rawRef, replacement } of sorted) {
    if (!rawRef) continue;
    // Wrap in quote-anchored patterns first so `path="/foo"` doesn't catch
    // a stray `/foo` substring in inline text.
    const quoted = [`"${rawRef}"`, `'${rawRef}'`];
    for (const q of quoted) {
      const replWith = q[0]! + replacement + q[0]!;
      out = out.split(q).join(replWith);
    }
    // Fall through — some `srcset` / `style` references don't wear quotes.
    // Bounded literal replace to avoid the regex-cost trap.
    if (rawRef.length >= 4) out = out.split(rawRef).join(replacement);
  }
  return out;
}

export function mimeFromKind(kind: DiscoveredResource["kind"]): string {
  // Fallback MIME when the response carried no Content-Type. Use a concrete
  // type the browser can render rather than a wildcard (which is not valid
  // in a `data:` URI). These are best-guesses, not authoritative — the
  // upstream response should be carrying Content-Type in any sane setup.
  switch (kind) {
    case "image":
      return "image/png";
    case "font":
      return "font/woff2";
    case "script":
      return "application/javascript";
    case "stylesheet":
      return "text/css";
    case "media":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

export function directorySize(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = d + sep + entry.name;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          /* best-effort */
        }
      }
    }
  };
  walk(dir);
  return total;
}
