// Centralized URL/identity redaction for everything that leaves the server
// carrying *captured* page traffic — HTTP request lists, WebSocket/SSE frame
// endpoints, and URL substrings inside console / page-error text.
//
// browxai output is meant to be shareable (issue repros, adoption reports)
// and the server is heading public, so this is a default-on posture, not a
// per-call opt-in: credential / identity-bearing material (query strings,
// fragments, userinfo, token-shaped path segments) is stripped at the egress
// boundary while the analytically useful shape — scheme, host, path pattern —
// is preserved. One implementation; HTTP / WS / SSE / console all route here.

/** A single path segment → itself, or `:id` when it looks like an identifier
 *  or an opaque credential/token (numeric, UUID, long hex, or a long
 *  high-entropy token). Conservative on length so human-readable route words
 *  ("profile", "avatar", "v2") are preserved. */
export function patterniseSegment(seg: string): string {
  if (!seg) return seg;
  if (/^\d+$/.test(seg)) return ":id";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
  if (/^[0-9a-f]{12,}$/i.test(seg)) return ":id";
  // Opaque token / JWT-ish: long, only token-safe chars, and mixes a letter
  // with a digit (route words like "documentation" never match — no digit).
  if (seg.length >= 20 && /^[A-Za-z0-9._~-]+$/.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg)) {
    return ":id";
  }
  return seg;
}

/** Patternise every segment of a pathname. */
export function patternisePath(pathname: string): string {
  return pathname.split("/").map(patterniseSegment).join("/");
}

/**
 * Redact a single URL: keep scheme + host + patternised path; drop the query
 * string, fragment, and any `user:pass@` userinfo. A present-but-stripped
 * query/fragment is signalled with `?…` / `#…` so the agent still knows it
 * existed without seeing its contents. Opaque schemes (`blob:`, `data:`)
 * collapse to just the scheme — their body can itself embed a full URL.
 * Non-URL input is returned unchanged.
 */
export function sanitizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol === "blob:" || u.protocol === "data:") return `${u.protocol}…`;
  const path = patternisePath(u.pathname);
  const q = u.search ? "?…" : "";
  const frag = u.hash ? "#…" : "";
  // u.origin excludes userinfo; for ws/wss/http/https it is `scheme://host`.
  const base = u.origin && u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`;
  return `${base}${path}${q}${frag}`;
}

// http(s)/ws(s) URL occurrences inside free text (console messages, page-error
// strings). Bounded charset stops at the first whitespace / quote / angle.
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>`)\]}]+/gi;

/** Replace every URL substring in arbitrary text with its sanitized form.
 *  Leaves all non-URL text untouched. */
export function sanitizeUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (m) => sanitizeUrl(m));
}
