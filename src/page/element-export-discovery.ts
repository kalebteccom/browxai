// Element-export subtree discovery + asset emission helpers — the page-side
// `SUBTREE_DISCOVERY_FN` (outerHTML + CSS + linked resources), the per-URL fetch
// script, and the filename/mime/ext/subdir naming + HTML-rewrite + standalone-
// wrap utilities. Split out of element-export.ts so the orchestrator stays under
// the size budget; behavior-identical.

import { extname, sep } from "node:path";
import { statSync, readdirSync } from "node:fs";

/** One resource the element subtree references. Same shape as
 *  `archive.ts`'s `DiscoveredResource`. */
export interface DiscoveredResource {
  url: string;
  kind: "image" | "font" | "script" | "stylesheet" | "media" | "other";
  rawRef: string;
}

export interface SubtreeDiscovery {
  /** outerHTML of the resolved element subtree. */
  html: string;
  /** Concatenated CSS — page-level stylesheets + inline <style> contents. */
  css: string;
  /** Stylesheets unreadable due to cross-origin `cssRules` restrictions. */
  unreadableStylesheets: number;
  resources: DiscoveredResource[];
}

/** Thin Locator-shaped adapter for `locator.evaluate(SUBTREE_DISCOVERY_FN)`. */
export interface ElementExportLocator {
  count(): Promise<number>;
  evaluate<T>(fn: (element: Element) => T | Promise<T>): Promise<T>;
}

/** Thin Page-shaped adapter — used for `page.evaluate(buildFetchScript)`. */
export interface ElementExportPage {
  evaluate(expression: string): Promise<unknown>;
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
export const SUBTREE_DISCOVERY_FN = (el: Element): SubtreeDiscovery => {
  function abs(u: string): string | null {
    try {
      return new URL(u, document.baseURI).href;
    } catch (_) {
      return null;
    }
  }
  function bgUrls(node: Element): string[] {
    const out: string[] = [];
    try {
      const cs = getComputedStyle(node);
      const bg = cs && cs.backgroundImage;
      if (bg && bg !== "none") {
        const re = /url\((['"]?)([^'")]+)\1\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(bg)) !== null) out.push(m[2]!);
      }
    } catch {
      // best-effort: getComputedStyle may throw on detached / cross-origin nodes
    }
    return out;
  }
  const resources: DiscoveredResource[] = [];
  const seen = Object.create(null) as Record<string, true>;
  function push(raw: string | null | undefined, kind: DiscoveredResource["kind"]): void {
    if (!raw) return;
    const a = abs(raw);
    if (!a) return;
    if (!/^https?:|^ftp:|^file:/i.test(a)) return;
    const key = a + "|" + kind;
    if (seen[key]) return;
    seen[key] = true;
    resources.push({ url: a, kind, rawRef: raw });
  }
  function srcKind(tag: string): DiscoveredResource["kind"] {
    if (tag === "img" || tag === "source") return "image";
    if (tag === "script") return "script";
    if (tag === "video" || tag === "audio" || tag === "track") return "media";
    return "other";
  }
  function linkRelKind(rel: string, asAttr: string): DiscoveredResource["kind"] {
    if (rel.indexOf("stylesheet") !== -1) return "stylesheet";
    if (rel.indexOf("icon") !== -1) return "image";
    if (asAttr === "font") return "font";
    if (asAttr === "script") return "script";
    if (asAttr === "image") return "image";
    if (asAttr === "style") return "stylesheet";
    return "other";
  }
  function pushHref(n: Element, tag: string, href: string): void {
    if (tag === "link") {
      const rel = (n.getAttribute("rel") || "").toLowerCase();
      const asAttr = (n.getAttribute("as") || "").toLowerCase();
      push(href, linkRelKind(rel, asAttr));
    } else if (tag === "image" || tag === "use") {
      push(href, "image");
    }
  }
  function scanNode(n: Element): void {
    if (n.nodeType !== 1) return;
    const tag = (n.tagName || "").toLowerCase();
    const s = n.getAttribute("src");
    if (s) push(s, srcKind(tag));
    const href = n.getAttribute("href");
    if (href && (tag === "link" || tag === "a" || tag === "use" || tag === "image")) {
      pushHref(n, tag, href);
    }
    const ss = n.getAttribute("srcset");
    if (ss) {
      const first = ss.split(",")[0]!.trim().split(/\s+/)[0];
      if (first) push(first, "image");
    }
    const poster = n.getAttribute("poster");
    if (poster) push(poster, "image");
    for (const b of bgUrls(n)) push(b, "image");
  }
  function scan(root: Element): void {
    const nodes: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
    for (let i = 0; i < nodes.length && i < 5000; i++) scanNode(nodes[i]!);
  }
  scan(el);
  const cssParts: string[] = [];
  let unreadable = 0;
  try {
    const sheets = document.styleSheets;
    for (let si = 0; si < sheets.length; si++) {
      try {
        const rules = sheets[si]!.cssRules;
        if (!rules) {
          unreadable++;
          continue;
        }
        let part = "";
        for (let ri = 0; ri < rules.length; ri++) {
          part += rules[ri]!.cssText + "\n";
        }
        cssParts.push(part);
      } catch {
        unreadable++;
      }
    }
  } catch {
    // best-effort: document.styleSheets enumeration can throw on hostile docs
  }
  return {
    html: el.outerHTML || "",
    css: cssParts.join("\n"),
    unreadableStylesheets: unreadable,
    resources,
  };
};

/** Build the page-side fetch script — identical posture to
 *  `archive.ts::buildFetchScript`. We import it here rather than the
 *  archive's version so future tweaks (e.g. CSP heuristic) can diverge
 *  per consumer. */
export function buildFetchScript(url: string): string {
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

export interface FetchedResource {
  ok: boolean;
  base64?: string;
  contentType?: string;
  bytes?: number;
  status?: number;
  error?: string;
}

export function assetFilename(url: string, kind: DiscoveredResource["kind"], contentType: string): string {
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

export function mimeFromKind(kind: DiscoveredResource["kind"]): string {
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

/** Rewrite raw HTML — replace every recorded `rawRef` with the relative
 *  asset path the file has been written to. Same logic as
 *  `archive.ts::rewriteHtml`. */
export function rewriteHtml(
  html: string,
  replacements: Array<{ rawRef: string; replacement: string }>,
): string {
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

/** Compose the standalone HTML document wrapper around an element snippet
 *  + its CSS. The wrapper is minimal so the snippet renders the way it
 *  did on the source page (UTF-8, default base, the captured stylesheet
 *  text). */
export function wrapStandalone(elementHtml: string, css: string, baseUri: string): string {
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
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
