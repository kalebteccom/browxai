// Origin allow/blocklist —  defense-in-depth gate (NOT a security boundary).
// See `docs/threat-model.md` for the framing: this is a blast-radius reducer + a hook
// point for confirmation prompts, *not* a guarantee that off-allowlist requests can't
// happen (page-initiated redirects, JS-driven nav, BYOB-mode etc. can still escape).
//
// Configuring:
//   BROWX_ALLOWED_ORIGINS=https://app.example.com,https://api.example.com,https://*.cdn.example.com
//   BROWX_BLOCKED_ORIGINS=https://*.tracking.example.com,https://ads.example.com

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
  const allowed = parseList(env.BROWX_ALLOWED_ORIGINS?.trim() ?? "");
  const blocked = parseList(env.BROWX_BLOCKED_ORIGINS?.trim() ?? "");
  return { allowed, blocked };
}

function parseList(raw: string): OriginPattern[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parsePattern);
}

function parsePattern(raw: string): OriginPattern {
  // Accept `https://app.example.com`, `https://*.example.com`, `http://localhost:3000`.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `origin policy: invalid URL "${raw}". Expected e.g. "https://app.example.com".`,
    );
  }
  const protocol = url.protocol;
  const hostPattern = url.hostname;
  const port = url.port; // may be ""
  const isWild = hostPattern.startsWith("*.");
  const wildSuffix = isWild ? hostPattern.slice(1) : ""; // ".example.com" for "*.example.com"

  const test = (candidate: URL): boolean => {
    if (candidate.protocol !== protocol) return false;
    if (port && candidate.port && candidate.port !== port) return false;
    if (isWild) {
      // Match exact suffix domain or sub-domain (not the bare suffix itself).
      return (
        candidate.hostname.endsWith(wildSuffix) && candidate.hostname.length > wildSuffix.length
      );
    }
    return candidate.hostname === hostPattern;
  };
  return { raw, test };
}

/** Returns true iff the URL is *allowed* under the policy (and not blocked). */
export function isOriginAllowed(url: string | URL, policy: OriginPolicy): boolean {
  const parsed = typeof url === "string" ? safeUrl(url) : url;
  if (!parsed) return false; // unparseable URLs aren't trusted
  if (policy.blocked.some((p) => p.test(parsed))) return false;
  if (policy.allowed.length === 0) return true; // no allowlist = no restriction
  return policy.allowed.some((p) => p.test(parsed));
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** Pretty-print for startup log. */
export function describePolicy(policy: OriginPolicy): string {
  if (policy.allowed.length === 0 && policy.blocked.length === 0) return "(none)";
  const bits: string[] = [];
  if (policy.allowed.length) bits.push(`allowed=[${policy.allowed.map((p) => p.raw).join(", ")}]`);
  if (policy.blocked.length) bits.push(`blocked=[${policy.blocked.map((p) => p.raw).join(", ")}]`);
  return bits.join(" ");
}
