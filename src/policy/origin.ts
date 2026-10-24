// Origin allow/blocklist —  defense-in-depth gate (NOT a security boundary).
// See `docs/threat-model.md` for the framing: this is a blast-radius reducer + a hook
// point for confirmation prompts, *not* a guarantee that off-allowlist requests can't
// happen (page-initiated redirects, JS-driven nav, BYOB-mode etc. can still escape).
//
// Configuring:
//   BROWX_ALLOWED_ORIGINS=https://app.example.com,https://api.example.com,https://*.cdn.example.com
//   BROWX_BLOCKED_ORIGINS=https://*.tracking.example.com,https://ads.example.com

import { safeUrl, unwrapOrigin } from "../util/origin-unwrap.js";

export interface OriginPolicy {
  /** Empty allowlist = no restriction ( default). */
  readonly allowed: ReadonlyArray<OriginPattern>;
  /** Blocked overrides allowed: an origin in `blocked` returns false even if in `allowed`. */
  readonly blocked: ReadonlyArray<OriginPattern>;
}

export interface OriginPattern {
  /** The original string, kept for error messages. */
  raw: string;
  /** Pre-compiled matcher: protocol exact, host wildcard-aware. */
  test(originUrl: URL): boolean;
}

export function resolveOriginPolicy(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const allowed = parseList(env.BROWX_ALLOWED_ORIGINS?.trim() ?? "", "BROWX_ALLOWED_ORIGINS");
  const blocked = parseList(env.BROWX_BLOCKED_ORIGINS?.trim() ?? "", "BROWX_BLOCKED_ORIGINS");
  return { allowed, blocked };
}

function parseList(raw: string, variable: string): OriginPattern[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => parsePattern(entry, variable));
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
  "ftp:": "21",
};

/** Host as compared by a pattern: lowercase with any trailing dots removed, so
 *  `ads.example.com.` and `ads.example.com` are the same host. `URL` has already
 *  lowercased and punycoded the name. */
function normaliseHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** The port a request to this URL uses: the explicit one, else the scheme default. */
function effectivePort(u: URL): string {
  return u.port || DEFAULT_PORTS[u.protocol] || "";
}

function parsePattern(raw: string, variable: string): OriginPattern {
  // Accept `https://app.example.com`, `https://*.example.com`, `http://localhost:3000`.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${variable}: invalid URL "${raw}". Use full origins separated by commas, e.g. "https://app.example.com" or "https://*.example.com".`,
    );
  }
  const protocol = url.protocol;
  const hostPattern = normaliseHost(url.hostname);
  const port = effectivePort(url);
  const isWild = hostPattern.startsWith("*.");
  const wildSuffix = isWild ? hostPattern.slice(1) : ""; // ".example.com" for "*.example.com"

  const test = (candidate: URL): boolean => {
    if (candidate.protocol !== protocol) return false;
    if (effectivePort(candidate) !== port) return false;
    const host = normaliseHost(candidate.hostname);
    if (isWild) {
      // Match exact suffix domain or sub-domain (not the bare suffix itself).
      return host.endsWith(wildSuffix) && host.length > wildSuffix.length;
    }
    return host === hostPattern;
  };
  return { raw, test };
}

/** Returns true iff the URL is *allowed* under the policy (and not blocked). */
export function isOriginAllowed(url: string | URL, policy: OriginPolicy): boolean {
  const parsed = typeof url === "string" ? safeUrl(url) : url;
  const target = parsed && unwrapOrigin(parsed);
  if (!target) return false; // unparseable URLs aren't trusted
  if (policy.blocked.some((p) => p.test(target))) return false;
  if (policy.allowed.length === 0) return true; // no allowlist = no restriction
  return policy.allowed.some((p) => p.test(target));
}

/** The `BROWX_BLOCKED_ORIGINS` entry that matches this URL, or null when none
 *  does. Lets a warning or refusal name the entry. */
export function blockedByPattern(url: string | URL, policy: OriginPolicy): string | null {
  const parsed = typeof url === "string" ? safeUrl(url) : url;
  const target = parsed && unwrapOrigin(parsed);
  if (!target) return null;
  return policy.blocked.find((p) => p.test(target))?.raw ?? null;
}

/** Pretty-print for startup log. */
export function describePolicy(policy: OriginPolicy): string {
  if (policy.allowed.length === 0 && policy.blocked.length === 0) return "(none)";
  const bits: string[] = [];
  if (policy.allowed.length) bits.push(`allowed=[${policy.allowed.map((p) => p.raw).join(", ")}]`);
  if (policy.blocked.length) bits.push(`blocked=[${policy.blocked.map((p) => p.raw).join(", ")}]`);
  return bits.join(" ");
}
