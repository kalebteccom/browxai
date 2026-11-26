// Which URL schemes the navigation tools open. A pure classifier over strings:
// the tool layer decides what each kind needs (a capability, a workspace path,
// an operator opt-in), this module only names the kind.
//
// Configuring:
//   BROWX_NAVIGATE_EXTRA_SCHEMES=chrome,view-source,about
// Read from the server's environment only. It is not a config-store key, so a
// saved or session config layer cannot add to it.

export type NavigationUrlKind =
  "web" | "blank" | "data" | "file" | "script" | "extension" | "other" | "unparseable";

export interface NavigationUrlClass {
  kind: NavigationUrlKind;
  /** Lowercase scheme without the colon; empty when the URL does not parse. */
  scheme: string;
  /** For a wrapping scheme (`view-source:`), the URL it wraps. The wrapped URL
   *  is what the browser reads, so the caller classifies it too. */
  inner?: string;
}

const KIND_BY_SCHEME: Readonly<Record<string, NavigationUrlKind>> = {
  http: "web",
  https: "web",
  data: "data",
  file: "file",
  javascript: "script",
  "chrome-extension": "extension",
  "moz-extension": "extension",
};

/** Schemes that wrap another URL after the colon. */
const WRAPPING_SCHEMES: ReadonlySet<string> = new Set(["view-source"]);

/**
 * Classify a URL the way the browser's own parser reads it: `new URL` applies
 * the same rules (scheme lowercased, surrounding whitespace and embedded tabs
 * and newlines dropped), so `FILE:///x` and ` file:///x` are both `file`.
 */
export function classifyNavigationUrl(url: string): NavigationUrlClass {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "unparseable", scheme: "" };
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme === "about") {
    return { kind: parsed.pathname === "blank" ? "blank" : "other", scheme };
  }
  const kind = KIND_BY_SCHEME[scheme] ?? "other";
  if (WRAPPING_SCHEMES.has(scheme)) {
    return { kind, scheme, inner: parsed.href.slice(scheme.length + 1) };
  }
  return { kind, scheme };
}

const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/;

/**
 * Parse `BROWX_NAVIGATE_EXTRA_SCHEMES`: the schemes outside the default set
 * that the operator lets the navigation tools open. Entries are scheme names,
 * with or without the trailing colon. A scheme a capability already governs
 * (`file`, `javascript`, the extension schemes) is refused here, because the
 * capability is how it is turned on. A scheme that is always open is accepted
 * and changes nothing. Throws on a malformed entry so a typo fails the start.
 */
export function resolveNavigateExtraSchemes(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const raw = env.BROWX_NAVIGATE_EXTRA_SCHEMES?.trim() ?? "";
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    const scheme = entry.replace(/:(\/\/)?$/, "");
    if (!SCHEME_NAME.test(scheme)) {
      throw new Error(
        `BROWX_NAVIGATE_EXTRA_SCHEMES: invalid scheme "${part.trim()}". Use scheme names separated by commas, e.g. "chrome,view-source".`,
      );
    }
    const kind = KIND_BY_SCHEME[scheme];
    if (kind === "file" || kind === "script" || kind === "extension") {
      const capability = kind === "file" ? "file-io" : kind === "script" ? "eval" : "extensions";
      throw new Error(
        `BROWX_NAVIGATE_EXTRA_SCHEMES: "${scheme}" is turned on by the \`${capability}\` capability. Add \`${capability}\` to BROWX_CAPABILITIES.`,
      );
    }
    if (kind === undefined) out.add(scheme);
  }
  return out;
}
