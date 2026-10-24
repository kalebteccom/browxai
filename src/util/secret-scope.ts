// Secret scope as an origin. A registered secret may carry a scope, and the
// dispatch side materialises it only into a frame whose origin matches one of
// the scope's entries exactly: same scheme, same host, same port.
//
// Entry forms:
//   - `https://app.example.com`, `http://localhost:3000`, `app://com.acme.app`:
//     an origin. A trailing `/` is accepted; any other path, a query, a
//     fragment or userinfo is refused, so the scope never reads as a URL prefix.
//   - `app.example.com`, `app.example.com:8443`: a bare host means `https://`
//     on that host and port.
// No wildcards and no subdomain rules: `app.example.com` matches that host
// only. Hosts compare case-insensitively (the URL parser already lowercases
// special-scheme hosts; non-special ones like `app://` are lowercased here).

import { safeUrl, unwrapOrigin } from "./origin-unwrap.js";

/** One parsed scope entry. `port` is the URL parser's form: empty for the
 *  scheme's default port. */
export interface ScopeOrigin {
  protocol: string;
  hostname: string;
  port: string;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function scopeError(raw: string, why: string): Error {
  return new Error(
    `scope "${raw}" ${why}. A scope entry is an origin (\`https://app.example.com\`, ` +
      `\`http://localhost:3000\`) or a bare host (\`app.example.com\`, meaning https).`,
  );
}

/** Parse one scope entry into an origin, or throw a message naming the fix. */
export function parseScopeEntry(raw: string): ScopeOrigin {
  const s = raw.trim();
  if (!s) throw scopeError(raw, "is empty");
  if (s.includes("*")) throw scopeError(s, "uses a wildcard, which scopes do not support");
  const hasScheme = SCHEME_RE.test(s);
  if (!hasScheme && /[/?#@\\\s]/.test(s)) throw scopeError(s, "is not an origin");
  let u: URL;
  try {
    u = new URL(hasScheme ? s : `https://${s}`);
  } catch {
    throw scopeError(s, "does not parse");
  }
  const pathOk = u.pathname === "" || u.pathname === "/";
  if (u.username || u.password || u.search || u.hash || !pathOk || /[?#]$/.test(s)) {
    throw scopeError(s, "has a path, query, fragment or credentials");
  }
  if (!u.hostname) throw scopeError(s, "has no host");
  return { protocol: u.protocol, hostname: u.hostname.toLowerCase(), port: u.port };
}

/** Parse a scope (one entry or a list) into its origins. */
export function parseScope(scope: string | readonly string[]): ScopeOrigin[] {
  const entries = typeof scope === "string" ? [scope] : scope;
  if (entries.length === 0) throw new Error("scope list is empty");
  return entries.map(parseScopeEntry);
}

/** The origin a frame URL belongs to, or null when it has none a scope can
 *  name (`about:blank`, `about:srcdoc`, `data:`, `file:`, unparseable). A
 *  `blob:` or `filesystem:` URL belongs to its inner URL's origin, decided by
 *  the same `unwrapOrigin` the origin allowlist uses. */
export function targetOrigin(url: string): ScopeOrigin | null {
  const parsed = safeUrl(url);
  const u = parsed && unwrapOrigin(parsed);
  if (!u || !u.hostname) return null;
  return { protocol: u.protocol, hostname: u.hostname.toLowerCase(), port: u.port };
}

/** True when `url`'s origin equals one of `origins` exactly. */
export function scopeMatches(origins: readonly ScopeOrigin[], url: string): boolean {
  const t = targetOrigin(url);
  if (!t) return false;
  return origins.some(
    (o) => o.protocol === t.protocol && o.hostname === t.hostname && o.port === t.port,
  );
}

/** `scheme://host[:port]` for display and for binding a value to a page. */
export function formatOrigin(o: ScopeOrigin): string {
  return `${o.protocol}//${o.hostname}${o.port ? `:${o.port}` : ""}`;
}

/** The origin string of a page URL, or null when it has none. */
export function originOf(url: string): string | null {
  const t = targetOrigin(url);
  return t ? formatOrigin(t) : null;
}
