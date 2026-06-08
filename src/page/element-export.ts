/// <reference lib="dom" />
// `element_export` — save a specific element subtree as a self-contained
// HTML snippet plus its rendered CSS + linked resources.
//
// Sibling to `page_archive` (src/page/archive.ts), scoped to one element
// subtree instead of the whole document. The use case is "extract this
// component / card / table — I want the markup, the styles that make it
// look like it does, and the images / fonts it pulls — to a directory I
// can grep / diff / re-open offline".
//
// Two formats, same shape as page_archive:
//
//   - `directory` (default) — `<intoDir>/element.html` + `<intoDir>/assets/`
//     with every fetched resource. Internal `[src]` / `[href]` /
//     `background-image: url(...)` references in the element subtree are
//     rewritten to relative `assets/<kind>/<file>` paths.
//
//   - `single-file` — one HTML file at `<intoDir>` (a `.html` path) with
//     every linked resource inlined as `data:` URIs and computed styles
//     inlined per element. Same browser-engine soft-cap caveat as
//     `page_archive` (~150 MB).
//
// Resource discovery walks **only the element subtree** (not the whole
// document) for `[src]`, `[href]`, and computed `background-image: url(...)`
// — same heuristics as `archive.ts`'s DISCOVERY_SCRIPT but scoped to a
// `Node` instead of `document`. Stylesheets are captured page-wide (a
// stylesheet matters even if its rules only target the subtree); inline
// `<style>` blocks from the page are likewise carried over. The pragmatic
// trade-off: more CSS than strictly needed, but the snippet renders
// faithfully without the agent having to compose style extraction.
//
// Secrets-masking interplay: same deliberate gap as `page_archive`. The
// exported file is a faithful capture of the rendered subtree; running the
// per-session egress masking layer over it would corrupt inline JSON / CSS
// / binary bytes. The `warnings[]` array always carries the caveat as its
// first entry.

import { resolve as resolvePath } from "node:path";
import { mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join, sep, extname } from "node:path";
import type { Locator, Page } from "playwright-core";
import { resolveWorkspacePath } from "../session/storage.js";
import { locatorFor } from "./locator.js";
import type { RefRegistry } from "./refs.js";

/** Export format — mirrors `ArchiveFormat`. */
export type ElementExportFormat = "directory" | "single-file";

const DEFAULT_MAX_SIZE_MB = 50;
const SINGLE_FILE_SOFT_WARN_MB = 150;
const PER_RESOURCE_HARD_MB = 50;

export interface ElementExportArgs {
  /** Ref minted by a prior `snapshot()` / `find()` call. */
  ref: string;
  /** Format. Default `"directory"`. */
  format?: ElementExportFormat;
  /** Workspace-rooted output target. For `directory` format it's a
   *  directory path; for `single-file` it's a `.html` file. When omitted,
   *  defaults to `elements/<sessionId>-<ISO>-<ref>/` (directory) or
   *  `elements/<sessionId>-<ISO>-<ref>.html` (single-file). */
  intoDir?: string;
  /** Total export size cap (MB). Default 50 (smaller than `page_archive`'s
   *  200 — an element snippet is meant to be a slice, not a meal). */
  maxSizeMb?: number;
}

export interface ElementExportResult {
  ok: true;
  format: ElementExportFormat;
  /** The ref that was exported (echoed for audit). */
  ref: string;
  /** Absolute, workspace-rooted output path (directory or file). */
  path: string;
  /** Total export size on disk, in bytes. */
  sizeBytes: number;
  /** Resources successfully fetched + included. */
  resourceCount: number;
  /** Resources skipped — drop reasons match `page_archive`. */
  droppedCount: number;
  /** Non-fatal advisories. Always carries the secrets-masking caveat. */
  warnings: string[];
}

/** Default output target when `intoDir` is omitted. Workspace-relative,
 *  namespaced under `elements/<sessionId>-<ISO>-<ref>` to match the
 *  archive subdir-per-artefact convention. */
export function defaultElementExportPath(
  sessionId: string,
  ref: string,
  format: ElementExportFormat,
): string {
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  const safeRef = ref.replace(/[^A-Za-z0-9._-]/g, "_") || "el";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = `elements/${safeSession}-${ts}-${safeRef}`;
  return format === "single-file" ? `${stem}.html` : stem;
}

/** One resource the element subtree references. Same shape as
 *  `archive.ts`'s `DiscoveredResource`. */
interface DiscoveredResource {
  url: string;
  kind: "image" | "font" | "script" | "stylesheet" | "media" | "other";
  rawRef: string;
}

interface SubtreeDiscovery {
  /** outerHTML of the resolved element subtree. */
  html: string;
  /** Concatenated CSS — page-level stylesheets (cssText where readable)
   *  plus inline `<style>` block contents. Cross-origin stylesheets that
   *  the page can't read end up empty (browser security; we surface
   *  the gap as a warning when seen). */
  css: string;
  /** Count of stylesheets that were unreadable due to cross-origin
   *  restrictions on `cssRules`. */
  unreadableStylesheets: number;
  resources: DiscoveredResource[];
}

/** Page-side discovery function. Receives `el` as the element handle the
 *  Playwright locator resolved to. Passed as a real function literal (NOT
 *  a stringified expression) — `locator.evaluate(stringExpr)` evaluates
 *  the string in page context but returns the function value uncalled,
 *  which CDP can't serialize → undefined. The function literal is
 *  serialized by Playwright and invoked in-page with the element.
 *
 *  Body uses only DOM types the page context provides (Element + standard
 *  globals); no TS-only constructs survive serialization. */
const SUBTREE_DISCOVERY_FN = (el: Element): SubtreeDiscovery => {
  function abs(u: string): string | null {
    try { return new URL(u, document.baseURI).href; } catch (_) { return null; }
  }
  function bgUrls(node: Element): string[] {
    const out: string[] = [];
    try {
      const cs = getComputedStyle(node);
      const bg = cs && cs.backgroundImage;
      if (bg && bg !== 'none') {
        const re = /url\((['"]?)([^'")]+)\1\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(bg)) !== null) out.push(m[2]!);
      }
    } catch (_) {}
    return out;
  }
  const resources: DiscoveredResource[] = [];
  const seen: Record<string, true> = Object.create(null);
  function push(raw: string | null | undefined, kind: DiscoveredResource["kind"]): void {
    if (!raw) return;
    const a = abs(raw);
    if (!a) return;
    if (!/^https?:|^ftp:|^file:/i.test(a)) return;
    const key = a + '|' + kind;
    if (seen[key]) return;
    seen[key] = true;
    resources.push({ url: a, kind, rawRef: raw });
  }
  function scan(root: Element): void {
    const nodes: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
    for (let i = 0; i < nodes.length && i < 5000; i++) {
      const n = nodes[i]!;
      if (n.nodeType !== 1) continue;
      const tag = (n.tagName || '').toLowerCase();
      const s = n.getAttribute('src');
      if (s) {
        let k: DiscoveredResource["kind"] = 'other';
        if (tag === 'img' || tag === 'source') k = 'image';
        else if (tag === 'script') k = 'script';
        else if (tag === 'video' || tag === 'audio' || tag === 'track') k = 'media';
        else if (tag === 'iframe') k = 'other';
        push(s, k);
      }
      const href = n.getAttribute('href');
      if (href && (tag === 'link' || tag === 'a' || tag === 'use' || tag === 'image')) {
        const rel = (n.getAttribute('rel') || '').toLowerCase();
        let hk: DiscoveredResource["kind"] = 'other';
        if (tag === 'link') {
          if (rel.indexOf('stylesheet') !== -1) hk = 'stylesheet';
          else if (rel.indexOf('icon') !== -1) hk = 'image';
          else {
            const asAttr = (n.getAttribute('as') || '').toLowerCase();
            if (asAttr === 'font') hk = 'font';
            else if (asAttr === 'script') hk = 'script';
            else if (asAttr === 'image') hk = 'image';
            else if (asAttr === 'style') hk = 'stylesheet';
          }
          push(href, hk);
        } else if (tag === 'image' || tag === 'use') {
          push(href, 'image');
        }
      }
      const ss = n.getAttribute('srcset');
      if (ss) {
        const first = ss.split(',')[0]!.trim().split(/\s+/)[0];
        if (first) push(first, 'image');
      }
      const poster = n.getAttribute('poster');
      if (poster) push(poster, 'image');
      const bgs = bgUrls(n);
      for (const b of bgs) push(b, 'image');
    }
  }
  scan(el);
  const cssParts: string[] = [];
  let unreadable = 0;
  try {
    const sheets = document.styleSheets;
    for (let si = 0; si < sheets.length; si++) {
      try {
        const rules = sheets[si]!.cssRules;
        if (!rules) { unreadable++; continue; }
        let part = '';
        for (let ri = 0; ri < rules.length; ri++) {
          part += rules[ri]!.cssText + '\n';
        }
        cssParts.push(part);
      } catch (_) {
        unreadable++;
      }
    }
  } catch (_) {}
  return {
    html: el.outerHTML || '',
    css: cssParts.join('\n'),
    unreadableStylesheets: unreadable,
    resources,
  };
};

/** Build the page-side fetch script — identical posture to
 *  `archive.ts::buildFetchScript`. We import it here rather than the
 *  archive's version so future tweaks (e.g. CSP heuristic) can diverge
 *  per consumer. */
function buildFetchScript(url: string): string {
  const literal = JSON.stringify(url);
  return `(async () => {
  try {
    var r = await fetch(${literal}, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return { ok: false, status: r.status, contentType: r.headers.get('content-type') || '' };
    var ct = r.headers.get('content-type') || '';
    var buf = await r.arrayBuffer();
    var bytes = new Uint8Array(buf);
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
  const hash = simpleHash(url);
  const ext = urlExt || guessExtFromContentType(contentType) || guessExtFromKind(kind);
  return `${stem}-${hash}${ext}`;
}

function simpleHash(s: string): string {
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
    case "image": return ".bin";
    case "font": return ".font";
    case "script": return ".js";
    case "stylesheet": return ".css";
    case "media": return ".media";
    default: return ".bin";
  }
}

function subdirForKind(kind: DiscoveredResource["kind"]): string {
  switch (kind) {
    case "image": return "images";
    case "font": return "fonts";
    case "script": return "scripts";
    case "stylesheet": return "styles";
    case "media": return "media";
    default: return "other";
  }
}

function mimeFromKind(kind: DiscoveredResource["kind"]): string {
  switch (kind) {
    case "image": return "image/png";
    case "font": return "font/woff2";
    case "script": return "application/javascript";
    case "stylesheet": return "text/css";
    case "media": return "video/mp4";
    default: return "application/octet-stream";
  }
}

/** Rewrite raw HTML — replace every recorded `rawRef` with the relative
 *  asset path the file has been written to. Same logic as
 *  `archive.ts::rewriteHtml`. */
function rewriteHtml(html: string, replacements: Array<{ rawRef: string; replacement: string }>): string {
  const sorted = [...replacements].sort((a, b) => b.rawRef.length - a.rawRef.length);
  let out = html;
  for (const { rawRef, replacement } of sorted) {
    if (!rawRef) continue;
    const quoted = [`"${rawRef}"`, `'${rawRef}'`];
    for (const q of quoted) {
      const replWith = q[0]! + replacement + q[0]!;
      out = out.split(q).join(replWith);
    }
    if (rawRef.length >= 4) out = out.split(rawRef).join(replacement);
  }
  return out;
}

function directorySize(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = d + sep + entry.name;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        try { total += statSync(p).size; } catch { /* best-effort */ }
      }
    }
  };
  walk(dir);
  return total;
}

/** Thin Locator-shaped adapter so unit tests can stub the page surface
 *  without spawning Chromium. The runner only needs `count` + `evaluate`
 *  on the target element. `evaluate` takes a real function (Playwright
 *  serializes it + invokes in-page with the resolved element) — passing
 *  a stringified arrow expression returns the function value uncalled. */
export interface ElementExportLocator {
  count(): Promise<number>;
  evaluate<T>(fn: (element: Element) => T | Promise<T>): Promise<T>;
}

/** Thin Page-shaped adapter — used for `page.evaluate(buildFetchScript)`. */
export interface ElementExportPage {
  evaluate(expression: string): Promise<unknown>;
}

/** Compose the standalone HTML document wrapper around an element snippet
 *  + its CSS. The wrapper is minimal so the snippet renders the way it
 *  did on the source page (UTF-8, default base, the captured stylesheet
 *  text). */
function wrapStandalone(elementHtml: string, css: string, baseUri: string): string {
  // Embedding the CSS inline rather than as an external file matches the
  // "self-contained" promise. `baseUri` gives the rendered snippet a sane
  // base for any reference we *didn't* manage to rewrite (left as a remote
  // URL — the browser will follow it).
  const safeBase = baseUri ? `<base href="${escapeAttr(baseUri)}">` : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${safeBase}
<style>
${css}
</style>
</head>
<body>
${elementHtml}
</body>
</html>
`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Adapter that resolves the ref + runs `elementExport`. Lives in this
 * module so the server-side handler doesn't have to know the discovery
 * details. The caller passes the live Page (for the per-URL fetch
 * round-trip) and the resolved Locator.
 */
export async function elementExport(
  page: ElementExportPage,
  locator: ElementExportLocator,
  workspaceRoot: string,
  sessionId: string,
  args: ElementExportArgs,
): Promise<ElementExportResult> {
  const format: ElementExportFormat = args.format ?? "directory";
  const maxSizeMb = args.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
  if (!(maxSizeMb > 0) || maxSizeMb > 10_000) {
    throw new Error(
      `element_export: maxSizeMb must be in (0, 10000] — got ${maxSizeMb}.`,
    );
  }
  const maxBytes = Math.floor(maxSizeMb * 1024 * 1024);

  const relPath = args.intoDir ?? defaultElementExportPath(sessionId, args.ref, format);
  const resolved = resolveWorkspacePath(workspaceRoot, relPath, "element_export");

  // Ref must resolve to a real element. count() is fast and avoids a
  // confusing `evaluate` failure when the locator matches nothing.
  let matchCount: number;
  try {
    matchCount = await locator.count();
  } catch (e) {
    throw new Error(
      `element_export: ref "${args.ref}" did not resolve — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (matchCount === 0) {
    throw new Error(
      `element_export: ref "${args.ref}" did not match any element (re-snapshot the page or pass a fresh ref).`,
    );
  }

  // 1. Subtree discovery — outerHTML + page-wide CSS + linked resources.
  const discovered = await locator.evaluate<SubtreeDiscovery>(SUBTREE_DISCOVERY_FN);

  const warnings: string[] = [
    "element_export output is UNMASKED — secrets-masking would corrupt the export (literal-substring substitution breaks inline JSON / CSS / binary bytes). Treat the export as sensitive material, same posture as page_archive / dump_storage_state.",
  ];
  if (discovered.unreadableStylesheets > 0) {
    warnings.push(
      `${discovered.unreadableStylesheets} stylesheet(s) were cross-origin without CORS and could not be read into the export. ` +
      "Rules from those sheets that targeted the subtree won't appear in the captured CSS — the snippet may render differently than the source page.",
    );
  }

  // 2. Fetch resources in bounded batches — same shape as page_archive.
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
        const err = (f.r.error ?? "").toLowerCase();
        if (err.includes("connect-src") || err.includes("refused to connect") || err.includes("content security policy")) {
          cspBlocked++;
        }
        fetched.push(f);
        continue;
      }
      const bytes = f.r.bytes ?? 0;
      if (bytes > PER_RESOURCE_HARD_MB * 1024 * 1024) {
        perResourceOversize++;
        fetched.push({ res: f.res, r: { ok: false, error: `resource exceeded per-resource cap (${PER_RESOURCE_HARD_MB} MB)` } });
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
      "(typically `connect-src`). Counted in droppedCount.",
    );
  }
  if (perResourceOversize > 0) {
    warnings.push(
      `${perResourceOversize} resource(s) exceeded the per-resource ${PER_RESOURCE_HARD_MB} MB cap and were dropped.`,
    );
  }
  if (budgetExhausted) {
    warnings.push(
      `Export size cap (maxSizeMb=${maxSizeMb}) reached — remaining resources were dropped. ` +
      "Raise `maxSizeMb` to capture more.",
    );
  }

  // 3. Emit the export.
  let resourceCount = 0;
  let droppedCount = 0;
  let sizeBytes = 0;
  const baseUri = ""; // populated below from page.evaluate if needed; the
                     // discovery script doesn't return baseURI, and embedding
                     // an arbitrary base would change relative-link resolution
                     // for any unmodified ref — leave empty.

  if (format === "directory") {
    // workspace-rooted (resolveWorkspacePath above rejects any escape from
    // BROWX_WORKSPACE). Every mkdirSync / writeFileSync below is anchored
    // on `resolved` or `dirname(resolved)`.
    mkdirSync(resolved, { recursive: true });
    const assetsRoot = join(resolved, "assets");
    // workspace-rooted: assetsRoot = join(resolved, ...), resolved ⊆ BROWX_WORKSPACE.
    mkdirSync(assetsRoot, { recursive: true });

    const replacements: Array<{ rawRef: string; replacement: string }> = [];
    for (const f of fetched) {
      if (!f.r.ok || !f.r.base64) { droppedCount++; continue; }
      const subdir = subdirForKind(f.res.kind);
      // workspace-rooted: dir = join(assetsRoot, ...), assetsRoot ⊆ BROWX_WORKSPACE.
      const dir = join(assetsRoot, subdir);
      mkdirSync(dir, { recursive: true });
      const filename = assetFilename(f.res.url, f.res.kind, f.r.contentType ?? "");
      // workspace-rooted: dest = join(dir, ...), dir ⊆ BROWX_WORKSPACE.
      const dest = join(dir, filename);
      writeFileSync(dest, Buffer.from(f.r.base64, "base64"));
      replacements.push({ rawRef: f.res.rawRef, replacement: `assets/${subdir}/${filename}` });
      resourceCount++;
    }
    const rewrittenHtml = rewriteHtml(discovered.html, replacements);
    const standalone = wrapStandalone(rewrittenHtml, discovered.css, baseUri);
    // workspace-rooted: indexPath = join(resolved, ...), resolved ⊆ BROWX_WORKSPACE.
    const indexPath = join(resolved, "element.html");
    writeFileSync(indexPath, standalone, "utf8");
    try {
      sizeBytes = directorySize(resolved);
    } catch {
      sizeBytes = Buffer.byteLength(standalone, "utf8") + runningBytes;
    }
  } else {
    // workspace-rooted: dirname(resolved) is the parent of a BROWX_WORKSPACE-anchored path.
    mkdirSync(dirname(resolved), { recursive: true });
    const replacements: Array<{ rawRef: string; replacement: string }> = [];
    for (const f of fetched) {
      if (!f.r.ok || !f.r.base64) { droppedCount++; continue; }
      const mime = (f.r.contentType ?? "").split(";")[0]!.trim() || mimeFromKind(f.res.kind);
      const dataUri = `data:${mime};base64,${f.r.base64}`;
      replacements.push({ rawRef: f.res.rawRef, replacement: dataUri });
      resourceCount++;
    }
    const rewrittenHtml = rewriteHtml(discovered.html, replacements);
    const standalone = wrapStandalone(rewrittenHtml, discovered.css, baseUri);
    // workspace-rooted by construction — `resolved` ⊆ BROWX_WORKSPACE.
    writeFileSync(resolved, standalone, "utf8");
    sizeBytes = statSync(resolved).size;
    if (sizeBytes > SINGLE_FILE_SOFT_WARN_MB * 1024 * 1024) {
      warnings.push(
        `single-file export is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. ` +
        `Browsers commonly struggle past ~${SINGLE_FILE_SOFT_WARN_MB} MB — use \`format:"directory"\` for large subtrees.`,
      );
    }
  }

  return {
    ok: true,
    format,
    ref: args.ref,
    path: resolvePath(resolved),
    sizeBytes,
    resourceCount,
    droppedCount,
    warnings,
  };
}

/**
 * Server-facing helper: resolve a ref through the registry, then call
 * `elementExport`. Lives here so the server.ts call site is a one-liner.
 */
export async function elementExportFromRef(
  page: Page,
  refs: RefRegistry,
  workspaceRoot: string,
  sessionId: string,
  args: ElementExportArgs,
): Promise<ElementExportResult> {
  const locator: Locator = locatorFor(page, refs, { ref: args.ref });
  const adapter: ElementExportLocator = {
    count: () => locator.count(),
    evaluate: <T,>(fn: (element: Element) => T | Promise<T>): Promise<T> =>
      locator.evaluate(fn),
  };
  const pageAdapter: ElementExportPage = { evaluate: (expr) => page.evaluate(expr) };
  return elementExport(pageAdapter, adapter, workspaceRoot, sessionId, args);
}
