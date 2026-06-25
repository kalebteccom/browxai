// `asset_export` naming helpers — the engine-blind, pure string transforms that
// turn a response URL into a safe on-disk filename and disambiguate collisions.
//
// These carry no CDP/Playwright dependency: given a string in, they hand a
// sanitised filename out. Kept apart from the fetch+persist orchestration in
// `asset-export.ts` so the filename posture (mirrors `downloads.sanitiseFilename`)
// can be reasoned about — and unit-tested — without spinning a NetworkBuffer.

import { basename } from "node:path";

/** Cap on the on-disk filename length, accounting for the `-N` collision
 *  suffix room and 255-byte filesystem name limits. */
const FILENAME_MAX_CHARS = 200;

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
