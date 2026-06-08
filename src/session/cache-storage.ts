// Cache API CRUD — Phase 7 storage-state surface extension.
//
// Sibling of cookies / localStorage / sessionStorage CRUD. Drives the W3C
// Cache API (`window.caches`) via `page.evaluate` — the same pattern the
// web-storage helpers in `storage.ts` use, and for the same reason: the
// Cache API is ORIGIN-SCOPED. The session MUST be navigated to the target
// origin before any of these tools work; on `about:blank` or a different
// origin the call rejects with a navigation hint.
//
// What's actually stored: each cache entry is keyed by a Request and
// carries a Response. The CRUD surface here treats the request side as a
// URL (the common shape Service Workers populate) and the response side
// as `{status, headers?, body}` with the body delivered as a UTF-8 string
// or base64 (auto-detected on the way out — text/* / application/json
// arrive as strings, anything else as `{contentBase64, byteLength}`).
//
// Capability split (server.ts):
//   - reads  (`caches_list_storages`, `caches_list`, `caches_get`) → `read`
//   - writes (`caches_put`, `caches_delete`, `caches_clear`,
//             `caches_delete_storage`)                              → `action`
//
// Tracker-ID hygiene: zero. Each cache entry is identified by its
// `(cacheName, url)` pair — the platform's native key. No synthetic IDs.

import type { Page } from "playwright-core";

/** Storage object on `window.caches`. */
const CACHE_API = "caches";

/** Origin-scope guard — same posture as web-storage. The Cache API is
 *  defined on every secure context Chromium ships, but it's still origin-
 *  bound: `window.caches.open()` returns the cache for the page's origin,
 *  not a global store. Navigate first. */
function cacheOriginGuard(page: Page, tool: string): void {
  let url: string;
  try { url = page.url(); } catch { url = ""; }
  if (!url || url === "about:blank") {
    throw new Error(
      `${tool}: Cache API is origin-scoped and the page is at "${url || "(unknown)"}". ` +
      `Navigate the session to the target origin first.`,
    );
  }
}

/** Result envelope for a cache-entry body — text-like content lands as a
 *  string, anything binary-ish as base64 + the byte count. */
export type CacheEntryBody =
  | { kind: "text"; text: string; contentType: string | null; status: number; headers: Record<string, string> }
  | { kind: "binary"; contentBase64: string; byteLength: number; contentType: string | null; status: number; headers: Record<string, string> };

// ---- reads -----------------------------------------------------------------

/** List every cache storage name visible to the current origin. */
export async function cachesListStorages(
  page: Page,
  tool: string,
): Promise<{ names: string[]; origin: string }> {
  cacheOriginGuard(page, tool);
  const expr =
    `(async () => { if (typeof ${CACHE_API} === "undefined") return { names: [], origin: location.origin }; ` +
    `var n = await ${CACHE_API}.keys(); ` +
    `return { names: n, origin: location.origin }; })()`;
  return (await page.evaluate(expr)) as { names: string[]; origin: string };
}

/** List the entries in a single cache. Optional `urlPattern` is a
 *  substring match against each entry's `request.url` (case-sensitive
 *  — adopters that want regex can filter the result themselves). */
export async function cachesList(
  page: Page,
  args: { cacheName: string; urlPattern?: string },
  tool: string,
): Promise<{ entries: Array<{ url: string; method: string }>; origin: string; cacheName: string }> {
  if (!args.cacheName) throw new Error(`${tool}: \`cacheName\` is required`);
  cacheOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var c = await ${CACHE_API}.open(${JSON.stringify(args.cacheName)}); ` +
    `var reqs = await c.keys(); ` +
    `var pat = ${JSON.stringify(args.urlPattern ?? "")}; ` +
    `var out = []; ` +
    `for (var i = 0; i < reqs.length; i++) { ` +
    `  var r = reqs[i]; ` +
    `  if (pat && r.url.indexOf(pat) === -1) continue; ` +
    `  out.push({ url: r.url, method: r.method }); ` +
    `} ` +
    `return { entries: out, origin: location.origin, cacheName: ${JSON.stringify(args.cacheName)} }; })()`;
  return (await page.evaluate(expr)) as { entries: Array<{ url: string; method: string }>; origin: string; cacheName: string };
}

/** Return the response body of a single entry. Text-like content types
 *  arrive as a UTF-8 string; everything else as base64. */
export async function cachesGet(
  page: Page,
  args: { cacheName: string; url: string },
  tool: string,
): Promise<{ found: false; cacheName: string; url: string; origin: string } | (CacheEntryBody & { found: true; cacheName: string; url: string; origin: string })> {
  if (!args.cacheName) throw new Error(`${tool}: \`cacheName\` is required`);
  if (!args.url) throw new Error(`${tool}: \`url\` is required`);
  cacheOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var c = await ${CACHE_API}.open(${JSON.stringify(args.cacheName)}); ` +
    `var res = await c.match(${JSON.stringify(args.url)}); ` +
    `if (!res) return { found: false, cacheName: ${JSON.stringify(args.cacheName)}, url: ${JSON.stringify(args.url)}, origin: location.origin }; ` +
    `var headers = {}; res.headers.forEach(function (v, k) { headers[k] = v; }); ` +
    `var ct = res.headers.get("content-type"); ` +
    `var isText = ct && /^(text\\/|application\\/(json|javascript|xml|x-www-form-urlencoded))|charset=/i.test(ct); ` +
    `if (isText) { var t = await res.text(); return { found: true, kind: "text", text: t, contentType: ct, status: res.status, headers: headers, cacheName: ${JSON.stringify(args.cacheName)}, url: ${JSON.stringify(args.url)}, origin: location.origin }; } ` +
    `var buf = await res.arrayBuffer(); ` +
    `var bytes = new Uint8Array(buf); var bin = ""; ` +
    `for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); ` +
    `var b64 = btoa(bin); ` +
    `return { found: true, kind: "binary", contentBase64: b64, byteLength: bytes.length, contentType: ct, status: res.status, headers: headers, cacheName: ${JSON.stringify(args.cacheName)}, url: ${JSON.stringify(args.url)}, origin: location.origin }; })()`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await page.evaluate(expr)) as any;
}

// ---- writes ----------------------------------------------------------------

/** Put an entry. `response.body` is either a UTF-8 string (default —
 *  same shape as the Cache API's `new Response(string)`) or base64 bytes
 *  via `{contentBase64: ...}`. Auto-opens (= creates) the cache storage. */
export async function cachesPut(
  page: Page,
  args: {
    cacheName: string;
    url: string;
    response: {
      status?: number;
      headers?: Record<string, string>;
      body?: string;
      contentBase64?: string;
    };
  },
  tool: string,
): Promise<{ ok: true; cacheName: string; url: string; origin: string }> {
  if (!args.cacheName) throw new Error(`${tool}: \`cacheName\` is required`);
  if (!args.url) throw new Error(`${tool}: \`url\` is required`);
  if (!args.response) throw new Error(`${tool}: \`response\` is required`);
  if (args.response.body !== undefined && args.response.contentBase64 !== undefined) {
    throw new Error(`${tool}: pass exactly one of \`response.body\` (string) or \`response.contentBase64\` — not both`);
  }
  cacheOriginGuard(page, tool);
  const bodyArg = JSON.stringify({
    body: args.response.body ?? null,
    contentBase64: args.response.contentBase64 ?? null,
    status: args.response.status ?? 200,
    headers: args.response.headers ?? {},
  });
  const expr =
    `(async () => { ` +
    `var spec = ${bodyArg}; ` +
    `var c = await ${CACHE_API}.open(${JSON.stringify(args.cacheName)}); ` +
    `var body; ` +
    `if (spec.contentBase64 !== null) { ` +
    `  var bin = atob(spec.contentBase64); ` +
    `  var bytes = new Uint8Array(bin.length); ` +
    `  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); ` +
    `  body = bytes; ` +
    `} else if (spec.body !== null) { body = spec.body; } else { body = ""; } ` +
    `var res = new Response(body, { status: spec.status, headers: spec.headers }); ` +
    `await c.put(${JSON.stringify(args.url)}, res); ` +
    `return { ok: true, cacheName: ${JSON.stringify(args.cacheName)}, url: ${JSON.stringify(args.url)}, origin: location.origin }; })()`;
  return (await page.evaluate(expr)) as { ok: true; cacheName: string; url: string; origin: string };
}

/** Delete one entry. Returns `existed:true` if the entry was present. */
export async function cachesDelete(
  page: Page,
  args: { cacheName: string; url: string },
  tool: string,
): Promise<{ ok: true; existed: boolean; cacheName: string; url: string; origin: string }> {
  if (!args.cacheName) throw new Error(`${tool}: \`cacheName\` is required`);
  if (!args.url) throw new Error(`${tool}: \`url\` is required`);
  cacheOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var c = await ${CACHE_API}.open(${JSON.stringify(args.cacheName)}); ` +
    `var existed = await c.delete(${JSON.stringify(args.url)}); ` +
    `return { ok: true, existed: existed, cacheName: ${JSON.stringify(args.cacheName)}, url: ${JSON.stringify(args.url)}, origin: location.origin }; })()`;
  return (await page.evaluate(expr)) as { ok: true; existed: boolean; cacheName: string; url: string; origin: string };
}

/** Clear every entry from a cache (the cache storage itself remains). */
export async function cachesClear(
  page: Page,
  args: { cacheName: string },
  tool: string,
): Promise<{ ok: true; cleared: number; cacheName: string; origin: string }> {
  if (!args.cacheName) throw new Error(`${tool}: \`cacheName\` is required`);
  cacheOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var c = await ${CACHE_API}.open(${JSON.stringify(args.cacheName)}); ` +
    `var reqs = await c.keys(); ` +
    `for (var i = 0; i < reqs.length; i++) await c.delete(reqs[i]); ` +
    `return { ok: true, cleared: reqs.length, cacheName: ${JSON.stringify(args.cacheName)}, origin: location.origin }; })()`;
  return (await page.evaluate(expr)) as { ok: true; cleared: number; cacheName: string; origin: string };
}

/** Delete a cache storage entirely. Returns `existed:true` if the storage
 *  was present (idempotent for callers — repeat calls return `existed:false`). */
export async function cachesDeleteStorage(
  page: Page,
  args: { cacheName: string },
  tool: string,
): Promise<{ ok: true; existed: boolean; cacheName: string; origin: string }> {
  if (!args.cacheName) throw new Error(`${tool}: \`cacheName\` is required`);
  cacheOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var existed = await ${CACHE_API}.delete(${JSON.stringify(args.cacheName)}); ` +
    `return { ok: true, existed: existed, cacheName: ${JSON.stringify(args.cacheName)}, origin: location.origin }; })()`;
  return (await page.evaluate(expr)) as { ok: true; existed: boolean; cacheName: string; origin: string };
}
