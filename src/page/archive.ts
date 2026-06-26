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

import { resolve as resolvePath } from "node:path";
import { resolveWorkspacePath } from "../session/storage.js";
import {
  buildFetchScript,
  type DiscoveredResource,
  type FetchedResource,
  type Fetched,
} from "./archive-assets.js";
import {
  emitArchiveDirectory,
  emitArchiveSingleFile,
  SINGLE_FILE_SOFT_WARN_MB,
} from "./archive-emit.js";

// The asset-naming + fetch + rewrite helpers (and their types) live in
// `archive-assets.ts`; re-export `DiscoveredResource` so callers that imported
// it from `./archive.js` are unchanged.
export type { DiscoveredResource } from "./archive-assets.js";

// The two emission strategies live in `archive-emit.ts`; re-export them so any
// caller that reaches for them through `./archive.js` is unchanged.
export { emitArchiveDirectory, emitArchiveSingleFile } from "./archive-emit.js";

/** Archive format. `directory` writes index.html + assets/ sidecar; `single-file`
 *  inlines every linked resource as a `data:` URI in one HTML file. */
export type ArchiveFormat = "directory" | "single-file";

/** Default size cap. Large enough for a meaty SPA + media, small enough that
 *  a runaway page (infinite-scroll, video stream) doesn't fill the
 *  workspace. Override with `maxSizeMb`. */
const DEFAULT_MAX_SIZE_MB = 200;

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

/** One linked resource the discovery script found. `kind` drives subdir
 *  placement in directory mode + content-type inference in single-file mode.
 *  Re-exported from `./archive-assets.js` (the type's home) at the top. */

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
  // 2. Fetch each resource (bounded concurrency + size budgets), then 3. emit.
  const phase = await fetchArchiveResources(page, discovered.resources, maxBytes);
  appendArchiveWarnings(phase, maxSizeMb, warnings);
  const emit =
    format === "directory"
      ? emitArchiveDirectory(resolved, discovered.html, phase.fetched, phase.runningBytes)
      : emitArchiveSingleFile(resolved, discovered.html, phase.fetched, warnings);

  return {
    ok: true,
    format,
    path: resolvePath(resolved),
    sizeBytes: emit.sizeBytes,
    resourceCount: emit.resourceCount,
    droppedCount: emit.droppedCount,
    warnings,
  };
}

interface ArchiveFetchPhase {
  fetched: Fetched[];
  cspBlocked: number;
  perResourceOversize: number;
  runningBytes: number;
  budgetExhausted: boolean;
}

const ARCHIVE_CSP_HINTS = ["connect-src", "refused to connect", "content security policy"];

/** Classify one fetched resource against the per-resource + total budget,
 *  mutating the running totals. Returns the (possibly budget-rejected) entry. */
function classifyArchiveFetched(f: Fetched, maxBytes: number, phase: ArchiveFetchPhase): Fetched {
  if (!f.r.ok) {
    const err = (f.r.error ?? "").toLowerCase();
    if (ARCHIVE_CSP_HINTS.some((h) => err.includes(h))) phase.cspBlocked++;
    return f;
  }
  const bytes = f.r.bytes ?? 0;
  if (bytes > PER_RESOURCE_HARD_MB * 1024 * 1024) {
    phase.perResourceOversize++;
    return {
      res: f.res,
      r: { ok: false, error: `resource exceeded per-resource cap (${PER_RESOURCE_HARD_MB} MB)` },
    };
  }
  if (phase.runningBytes + bytes > maxBytes) {
    phase.budgetExhausted = true;
    return { res: f.res, r: { ok: false, error: "size budget exhausted" } };
  }
  phase.runningBytes += bytes;
  return f;
}

/** Fetch the discovered resources in bounded concurrency batches, applying the
 *  per-resource + total size budgets. Stops early once the budget is exhausted. */
async function fetchArchiveResources(
  page: ArchivePage,
  resources: DiscoveredResource[],
  maxBytes: number,
): Promise<ArchiveFetchPhase> {
  const CONCURRENCY = 6;
  const phase: ArchiveFetchPhase = {
    fetched: [],
    cspBlocked: 0,
    perResourceOversize: 0,
    runningBytes: 0,
    budgetExhausted: false,
  };
  for (let i = 0; i < resources.length; i += CONCURRENCY) {
    const settled = await Promise.all(
      resources.slice(i, i + CONCURRENCY).map(async (res): Promise<Fetched> => {
        try {
          return { res, r: (await page.evaluate(buildFetchScript(res.url))) as FetchedResource };
        } catch (e) {
          return { res, r: { ok: false, error: e instanceof Error ? e.message : String(e) } };
        }
      }),
    );
    for (const f of settled) phase.fetched.push(classifyArchiveFetched(f, maxBytes, phase));
    if (phase.budgetExhausted) {
      for (let j = i + CONCURRENCY; j < resources.length; j++) {
        phase.fetched.push({
          res: resources[j]!,
          r: { ok: false, error: "size budget exhausted" },
        });
      }
      break;
    }
  }
  return phase;
}

/** Push the post-fetch budget/CSP warnings onto the result warnings. */
function appendArchiveWarnings(
  phase: ArchiveFetchPhase,
  maxSizeMb: number,
  warnings: string[],
): void {
  if (phase.cspBlocked > 0) {
    warnings.push(
      `${phase.cspBlocked} resource(s) blocked by the page's Content-Security-Policy ` +
        "(typically `connect-src` — fetch() inside the page is subject to the same " +
        "policy as the page itself). These are counted in droppedCount.",
    );
  }
  if (phase.perResourceOversize > 0) {
    warnings.push(
      `${phase.perResourceOversize} resource(s) exceeded the per-resource ${PER_RESOURCE_HARD_MB} MB cap and were dropped. ` +
        "Raise the per-resource cap by forking — the cap is hard-coded by design (an archive is fidelity, not a CDN).",
    );
  }
  if (phase.budgetExhausted) {
    warnings.push(
      `Archive size cap (maxSizeMb=${maxSizeMb}) reached — remaining resources were dropped. ` +
        "Raise `maxSizeMb` to capture more, but note browsers struggle with single-file archives > " +
        SINGLE_FILE_SOFT_WARN_MB +
        " MB.",
    );
  }
}
