// `page_archive` — save the current page as a self-contained archive.
//
// Two formats:
//
//   - `directory` (default) — write `<path>/index.html` plus a sidecar
//     `<path>/assets/` containing every linked resource the DOM-walk
//     discovered (images, fonts, scripts, stylesheets, CSS background
//     images surfaced via `getComputedStyle`). Internal references in the
//     serialised HTML are rewritten to relative `assets/...` paths. Browser-
//     openable straight off disk; the archive is a real directory the
//     adopter can grep / diff / repackage.
//
//   - `single-file` — one self-contained HTML file at `path` with every
//     resource inlined as a `data:` URI. The MHTML-equivalent without the
//     MIME-multipart format (which Chromium has dropped good support for in
//     the modern surface). One file to copy around; cap-bounded by `maxSizeMb`.
//
// Path safety mirrors `pdf_save` / `dump_storage_state`: every output path is
// resolved via `resolveWorkspacePath`, so a path that escapes
// `$BROWX_WORKSPACE` is rejected before any byte is written.
//
// Resource discovery walks the live DOM inside `page.evaluate` and pulls
// every node carrying a fetchable URL (`<img src>`, `<link href>`, `<script
// src>`, `<source>`, `<video poster>`, `<iframe src>` modulo cross-origin
// access, plus CSS `background-image: url(...)` from computed styles). Each
// URL is then fetched **from inside the page** via `await fetch(u)`, which
// inherits the page's origin (and credentials) — the only way to reliably
// pull resources that depend on session cookies or the page's CSP
// `connect-src` posture. Cross-origin fetches that CSP refuses are caught
// and surfaced in `droppedCount` + `warnings[]` rather than aborting the
// archive.
//
// Document HTML is captured with `document.documentElement.outerHTML` after
// the agent's own pre-archive wait. The tool does NOT inject its own wait;
// the agent is expected to navigate + settle the page BEFORE calling
// `page_archive`. Same posture as `pdf_save`.
//
// Secrets-masking interplay (DELIBERATE GAP):
//   The output is a *faithful* capture of the rendered page. Running the
//   per-session egress masking layer over the HTML / linked bytes would
//   corrupt the archive — masking is literal-substring substitution, would
//   break inline JSON state blobs, CSS, image bytes, and would produce a
//   file that no longer opens correctly. So `page_archive` writes UNMASKED
//   page state on purpose. The caller takes the same posture as
//   `dump_storage_state` toward the result: it may carry credentials, treat
//   the archive as sensitive material. Documented in tool-reference + flagged
//   on every result through `warnings[]`.

import { resolve as resolvePath, dirname, join, sep, extname } from "node:path";
import { mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import type { Page } from "playwright-core";
import { resolveWorkspacePath } from "../session/storage.js";

/** Archive format. `directory` writes index.html + assets/ sidecar; `single-file`
 *  inlines every linked resource as a `data:` URI in one HTML file. */
export type ArchiveFormat = "directory" | "single-file";

/** Default size cap. Large enough for a meaty SPA + media, small enough that
 *  a runaway page (infinite-scroll, video stream) doesn't fill the
 *  workspace. Override with `maxSizeMb`. */
const DEFAULT_MAX_SIZE_MB = 200;

/** Hard ceiling for single-file mode beyond the user's cap. Browsers
 *  routinely struggle to load HTML > ~150 MB into a single document — the
 *  in-memory `data:` URI cost compounds. We surface a warning when the
 *  single-file output exceeds this, but never refuse: the cap is the cap. */
const SINGLE_FILE_SOFT_WARN_MB = 150;

/** Resource hard ceiling per fetch — refuse to inline a single 500 MB video
 *  even if `maxSizeMb` would permit it. The point of an archive is fidelity,
 *  not turning the agent into a CDN. Surfaces a warning. */
const PER_RESOURCE_HARD_MB = 50;

export interface ArchiveArgs {
  /** Workspace-rooted output path. For `directory` it's a directory; for
   *  `single-file` it's a `.html` file. When omitted, defaults to
   *  `archives/<sessionId>-<ISO>` (directory) or
   *  `archives/<sessionId>-<ISO>.html` (single-file). */
  path?: string;
  /** Archive format. Default `"directory"`. */
  format?: ArchiveFormat;
  /** Total archive size cap (MB). Default 200. Hard cap — fetches that
   *  would push past the budget are dropped and counted. */
  maxSizeMb?: number;
}

export interface ArchiveResult {
  ok: true;
  format: ArchiveFormat;
  /** Absolute, workspace-rooted output path (directory or file). */
  path: string;
  /** Total archive size on disk, in bytes. */
  sizeBytes: number;
  /** Resources successfully fetched + included. */
  resourceCount: number;
  /** Resources skipped — unsupported scheme, fetch failure, oversize, or
   *  size budget exhausted. The total `discovered = resourceCount + droppedCount`. */
  droppedCount: number;
  /** Non-fatal advisories — secrets-masking caveat (always), CSP `connect-src`
   *  blocks (when seen), oversized single-file output, per-resource oversize
   *  hits. The set is small + deterministic; never noise. */
  warnings: string[];
}

/** Default output path when the caller omits one. Workspace-rooted under
 *  `archives/<sessionId>-<ISO>[.html]` — matches the `pdf_save` /
 *  `start_har` / `perf_stop` subdir-per-artefact convention. */
export function defaultArchivePath(sessionId: string, format: ArchiveFormat): string {
  // Match the sanitisation posture of `defaultPdfPath` — the registry
  // already constrains ids, this is belt-and-braces.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = `archives/${safe}-${ts}`;
  return format === "single-file" ? `${stem}.html` : stem;
}

/** Discovered resource — one URL the page references that we'll try to
 *  fetch. `kind` drives subdir placement in directory mode + content-type
 *  inference in single-file mode. */
interface DiscoveredResource {
  url: string;
  kind: "image" | "font" | "script" | "stylesheet" | "media" | "other";
  /** Original attribute text the discovery script saw — used to rewrite
   *  the HTML to point at the asset sidecar in directory mode. */
  rawRef: string;
}

/** Page-side discovery script — runs inside the page and returns the
 *  document HTML plus a list of every linked resource URL we can reach.
 *  Same pattern as `dom-walk.ts`: ECMAScript-only, stringified IIFE. */
const DISCOVERY_SCRIPT = `(() => {
  function abs(u) {
    try { return new URL(u, document.baseURI).href; } catch (_) { return null; }
  }
  function bgUrls(el) {
    var out = [];
    try {
      var cs = getComputedStyle(el);
      var bg = cs && cs.backgroundImage;
      if (bg && bg !== 'none') {
        var re = /url\\((['"]?)([^'")]+)\\1\\)/g, m;
        while ((m = re.exec(bg)) !== null) out.push(m[2]);
      }
    } catch (_) {}
    return out;
  }
  var resources = [];
  var seen = Object.create(null);
  function push(raw, kind) {
    if (!raw) return;
    var a = abs(raw);
    if (!a) return;
    // skip non-fetchable schemes — data:/blob:/about:/javascript: etc.
    if (!/^https?:|^ftp:|^file:/i.test(a)) return;
    var key = a + '|' + kind;
    if (seen[key]) return;
    seen[key] = 1;
    resources.push({ url: a, kind: kind, rawRef: raw });
  }
  // <img src>, <img srcset> (first candidate only — keep the discovery cheap)
  var imgs = document.querySelectorAll('img[src], img[srcset], source[src], source[srcset]');
  for (var i = 0; i < imgs.length; i++) {
    var el = imgs[i];
    var s = el.getAttribute('src');
    if (s) push(s, 'image');
    var ss = el.getAttribute('srcset');
    if (ss) {
      var first = ss.split(',')[0].trim().split(/\\s+/)[0];
      if (first) push(first, 'image');
    }
  }
  // <link rel="stylesheet|icon|preload|prefetch">
  var links = document.querySelectorAll('link[href]');
  for (var i = 0; i < links.length; i++) {
    var el = links[i];
    var rel = (el.getAttribute('rel') || '').toLowerCase();
    var href = el.getAttribute('href');
    if (!href) continue;
    var kind = 'other';
    if (rel.indexOf('stylesheet') !== -1) kind = 'stylesheet';
    else if (rel.indexOf('icon') !== -1) kind = 'image';
    else if (rel.indexOf('preload') !== -1 || rel.indexOf('prefetch') !== -1) {
      var as = (el.getAttribute('as') || '').toLowerCase();
      if (as === 'font') kind = 'font';
      else if (as === 'script') kind = 'script';
      else if (as === 'image') kind = 'image';
      else if (as === 'style') kind = 'stylesheet';
    }
    push(href, kind);
  }
  // <script src>
  var scripts = document.querySelectorAll('script[src]');
  for (var i = 0; i < scripts.length; i++) push(scripts[i].getAttribute('src'), 'script');
  // <video|audio src|poster>, <track src>
  var media = document.querySelectorAll('video[src], audio[src], video[poster], track[src]');
  for (var i = 0; i < media.length; i++) {
    var el = media[i];
    var s = el.getAttribute('src'); if (s) push(s, 'media');
    var p = el.getAttribute('poster'); if (p) push(p, 'image');
  }
  // <iframe src> — captured for fidelity even though cross-origin iframes
  // won't be reachable from a fetch in this document. The agent gets a
  // best-effort archive; cross-origin iframes are dropped at fetch time
  // and counted in droppedCount.
  var iframes = document.querySelectorAll('iframe[src]');
  for (var i = 0; i < iframes.length; i++) push(iframes[i].getAttribute('src'), 'other');
  // computed background-image — walk every visible element. Bounded — most
  // pages have <100 background-images; a runaway page is bounded by the
  // overall maxSizeMb cap downstream.
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length && i < 5000; i++) {
    var us = bgUrls(all[i]);
    for (var j = 0; j < us.length; j++) push(us[j], 'image');
  }
  return {
    html: document.documentElement ? document.documentElement.outerHTML : '',
    baseUri: document.baseURI || '',
    resources: resources,
  };
})()`;

/** Fetch one URL from inside the page, returning base64 + a content-type
 *  guess. Used in single-file mode (data: URIs) and as the byte source for
 *  directory mode. Failures are caught — the caller drops + counts. */
function buildFetchScript(url: string): string {
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

interface FetchedResource {
  ok: boolean;
  base64?: string;
  contentType?: string;
  bytes?: number;
  status?: number;
  error?: string;
}

/** Slugify a URL into a filesystem-safe asset filename. The hash prefix
 *  disambiguates same-name resources from different origins. */
function assetFilename(url: string, kind: DiscoveredResource["kind"], contentType: string): string {
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

function subdirForKind(kind: DiscoveredResource["kind"]): string {
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
function rewriteHtml(
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

/** Page handle adapter — `page_archive` only needs `evaluate`. Exposing a
 *  thin interface keeps the unit test mock trivial. */
export interface ArchivePage {
  evaluate(expression: string): Promise<unknown>;
}

/**
 * Write the page archive. Workspace-rooted by construction; the caller
 * (server.ts) has already gated on the `file-io` capability.
 */
export async function pageArchive(
  page: ArchivePage,
  workspaceRoot: string,
  sessionId: string,
  args: ArchiveArgs = {},
): Promise<ArchiveResult> {
  const format: ArchiveFormat = args.format ?? "directory";
  const maxSizeMb = args.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
  if (!(maxSizeMb > 0) || maxSizeMb > 10_000) {
    throw new Error(`page_archive: maxSizeMb must be in (0, 10000] — got ${maxSizeMb}.`);
  }
  const maxBytes = Math.floor(maxSizeMb * 1024 * 1024);

  const relPath = args.path ?? defaultArchivePath(sessionId, format);
  const resolved = resolveWorkspacePath(workspaceRoot, relPath, "page_archive");

  // 1. Run discovery inside the page — one round-trip, returns
  //    documentElement.outerHTML + the URL set.
  const discovered = (await page.evaluate(DISCOVERY_SCRIPT)) as {
    html: string;
    baseUri: string;
    resources: DiscoveredResource[];
  };

  const warnings: string[] = [
    // ALWAYS present — the secrets-masking caveat is part of the result
    // envelope, not buried in docs. An adopter automating archive collection
    // sees it on every call.
    "page_archive output is UNMASKED — secrets-masking would corrupt the archive (literal-substring substitution breaks inline JSON / CSS / binary bytes). Treat the archive as sensitive material, same posture as dump_storage_state.",
  ];

  // 2. Fetch each resource. Bound the parallelism so we don't tip the page
  //    over — small concurrency, sequential batches.
  const CONCURRENCY = 6;
  type Fetched = { res: DiscoveredResource; r: FetchedResource };
  const fetched: Fetched[] = [];
  let cspBlocked = 0;
  let perResourceOversize = 0;
  let runningBytes = 0;
  let budgetExhausted = false;
  for (let i = 0; i < discovered.resources.length; i += CONCURRENCY) {
    const batch = discovered.resources.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (res) => {
        try {
          const r = (await page.evaluate(buildFetchScript(res.url))) as FetchedResource;
          return { res, r };
        } catch (e) {
          return {
            res,
            r: { ok: false, error: e instanceof Error ? e.message : String(e) } as FetchedResource,
          };
        }
      }),
    );
    for (const f of settled) {
      if (!f.r.ok) {
        // CSP `connect-src` typically surfaces a TypeError mentioning
        // "Failed to fetch" or "Refused to connect". Treat any fetch
        // error as a drop; flag CSP separately when the message hints.
        const err = (f.r.error ?? "").toLowerCase();
        if (
          err.includes("connect-src") ||
          err.includes("refused to connect") ||
          err.includes("content security policy")
        ) {
          cspBlocked++;
        }
        fetched.push(f);
        continue;
      }
      const bytes = f.r.bytes ?? 0;
      if (bytes > PER_RESOURCE_HARD_MB * 1024 * 1024) {
        perResourceOversize++;
        fetched.push({
          res: f.res,
          r: {
            ok: false,
            error: `resource exceeded per-resource cap (${PER_RESOURCE_HARD_MB} MB)`,
          },
        });
        continue;
      }
      if (runningBytes + bytes > maxBytes) {
        budgetExhausted = true;
        fetched.push({ res: f.res, r: { ok: false, error: "size budget exhausted" } });
        continue;
      }
      runningBytes += bytes;
      fetched.push(f);
    }
    if (budgetExhausted) {
      // Drop any remaining resources without trying to fetch — we're full.
      for (let j = i + CONCURRENCY; j < discovered.resources.length; j++) {
        fetched.push({
          res: discovered.resources[j]!,
          r: { ok: false, error: "size budget exhausted" },
        });
      }
      break;
    }
  }
  if (cspBlocked > 0) {
    warnings.push(
      `${cspBlocked} resource(s) blocked by the page's Content-Security-Policy ` +
        "(typically `connect-src` — fetch() inside the page is subject to the same " +
        "policy as the page itself). These are counted in droppedCount.",
    );
  }
  if (perResourceOversize > 0) {
    warnings.push(
      `${perResourceOversize} resource(s) exceeded the per-resource ${PER_RESOURCE_HARD_MB} MB cap and were dropped. ` +
        "Raise the per-resource cap by forking — the cap is hard-coded by design (an archive is fidelity, not a CDN).",
    );
  }
  if (budgetExhausted) {
    warnings.push(
      `Archive size cap (maxSizeMb=${maxSizeMb}) reached — remaining resources were dropped. ` +
        "Raise `maxSizeMb` to capture more, but note browsers struggle with single-file archives > " +
        SINGLE_FILE_SOFT_WARN_MB +
        " MB.",
    );
  }

  // 3. Emit the archive in the requested format.
  // `resolved` is workspace-rooted by construction (resolveWorkspacePath
  // above rejects any escape from `$BROWX_WORKSPACE`). Every mkdirSync /
  // writeFileSync below is anchored on `resolved` or `dirname(resolved)`.
  let resourceCount = 0;
  let droppedCount = 0;
  let sizeBytes = 0;
  if (format === "directory") {
    // workspace-rooted (see comment above; `resolved` ⊆ $BROWX_WORKSPACE).
    mkdirSync(resolved, { recursive: true });
    const assetsRoot = join(resolved, "assets");
    // workspace-rooted: assetsRoot = join(resolved, ...), resolved ⊆ $BROWX_WORKSPACE.
    mkdirSync(assetsRoot, { recursive: true });

    const replacements: Array<{ rawRef: string; replacement: string }> = [];
    for (const f of fetched) {
      if (!f.r.ok || !f.r.base64) {
        droppedCount++;
        continue;
      }
      const subdir = subdirForKind(f.res.kind);
      // workspace-rooted: dir = join(assetsRoot, ...), assetsRoot ⊆ $BROWX_WORKSPACE.
      const dir = join(assetsRoot, subdir);
      mkdirSync(dir, { recursive: true });
      const filename = assetFilename(f.res.url, f.res.kind, f.r.contentType ?? "");
      // workspace-rooted: dest = join(dir, ...), dir ⊆ $BROWX_WORKSPACE.
      const dest = join(dir, filename);
      writeFileSync(dest, Buffer.from(f.r.base64, "base64"));
      replacements.push({ rawRef: f.res.rawRef, replacement: `assets/${subdir}/${filename}` });
      resourceCount++;
    }
    const rewritten = rewriteHtml(discovered.html, replacements);
    // workspace-rooted: indexPath = join(resolved, ...), resolved ⊆ $BROWX_WORKSPACE.
    const indexPath = join(resolved, "index.html");
    writeFileSync(indexPath, rewritten, "utf8");
    try {
      sizeBytes = directorySize(resolved);
    } catch {
      // best-effort — fall back to the resource ledger
      sizeBytes = Buffer.byteLength(rewritten, "utf8") + runningBytes;
    }
  } else {
    // single-file: inline every resource as a data: URI.
    // workspace-rooted: dirname(resolved) is the parent of a $BROWX_WORKSPACE-anchored path.
    mkdirSync(dirname(resolved), { recursive: true });
    const replacements: Array<{ rawRef: string; replacement: string }> = [];
    for (const f of fetched) {
      if (!f.r.ok || !f.r.base64) {
        droppedCount++;
        continue;
      }
      const mime = (f.r.contentType ?? "").split(";")[0]!.trim() || mimeFromKind(f.res.kind);
      const dataUri = `data:${mime};base64,${f.r.base64}`;
      replacements.push({ rawRef: f.res.rawRef, replacement: dataUri });
      resourceCount++;
    }
    const rewritten = rewriteHtml(discovered.html, replacements);
    // workspace-rooted by construction — `resolved` ⊆ $BROWX_WORKSPACE.
    writeFileSync(resolved, rewritten, "utf8");
    sizeBytes = statSync(resolved).size;
    if (sizeBytes > SINGLE_FILE_SOFT_WARN_MB * 1024 * 1024) {
      warnings.push(
        `single-file archive is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. ` +
          `Browsers commonly struggle to open inline-data HTML beyond ~${SINGLE_FILE_SOFT_WARN_MB} MB ` +
          '(the data: URI cost compounds in-memory). Use `format:"directory"` for large pages.',
      );
    }
  }

  return {
    ok: true,
    format,
    path: resolvePath(resolved),
    sizeBytes,
    resourceCount,
    droppedCount,
    warnings,
  };
}

function mimeFromKind(kind: DiscoveredResource["kind"]): string {
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

function directorySize(dir: string): number {
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
