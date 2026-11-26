// The scheme and landing checks shared by `navigate`, `go_back` and `go_forward`.
//
// `navigationRefusal` decides whether a URL may be opened at all: web, blank and
// `data:` URLs always, a `file:` URL with `file-io` and a path inside the
// workspace, `javascript:` with `eval`, an extension page with `extensions`, and
// any other scheme only when the operator listed it in
// `BROWX_NAVIGATE_EXTRA_SCHEMES`. `checkLanding` runs the same decision on the
// URL the page ended on, then the origin rules.

import { fileURLToPath } from "node:url";
import { confirmLanding } from "../policy/confirm.js";
import { classifyNavigationUrl } from "../policy/navigation-scheme.js";
import { redactUrlForLog } from "../util/url-sanitizer.js";
import { resolveWorkspaceReadPath } from "../util/workspace.js";
import type { SessionEntry } from "../session/registry.js";
import type { ActionHost, ConfigHost, GateHost, SessionHost, ToolResponse } from "./host.js";
import { jsonResult } from "./json-result.js";

/** What the scheme decision reads. A slice of the host, so a unit test passes
 *  three plain values. */
export interface NavigationSchemeDeps {
  gateCheck: GateHost["gateCheck"];
  workspaceRoot: string;
  extraSchemes: ReadonlySet<string>;
}

/** The host slice the navigation tools pass in. */
export type NavigationGateHost = GateHost &
  SessionHost &
  ActionHost &
  Pick<ConfigHost, "workspace" | "navigateExtraSchemes">;

const schemeDepsOf = (host: NavigationGateHost): NavigationSchemeDeps => ({
  gateCheck: host.gateCheck,
  workspaceRoot: host.workspace.root,
  extraSchemes: host.navigateExtraSchemes,
});

/**
 * True when the session's engine drives a native app. `navigate` there opens a
 * deep link (`myapp://checkout/42`) that the OS routes to an app, so the URL is
 * no browser address and the scheme rules do not describe it. Read from the
 * engine's declaration: a native-app engine has no document, and so declares no
 * web `storage`. An engine with no declaration counts as a browser.
 */
const opensDeepLinks = (host: NavigationGateHost, tool: string, e: SessionEntry): boolean =>
  host.subInterfaceGate(tool, "storage", e) !== null;

/** Refusal content when the session may not open the requested `url`, else null. */
export function requestedUrlRefusal(
  host: NavigationGateHost,
  tool: string,
  e: SessionEntry,
  url: string,
): ToolResponse | null {
  if (opensDeepLinks(host, tool, e)) return null;
  return navigationRefusal(schemeDepsOf(host), tool, url);
}

/** The browser's own error page. It carries no content, so a failed load that
 *  ends there is left for the ActionResult to report. */
const BROWSER_ERROR_SCHEME = "chrome-error";

const EXTRA_SCHEMES_HINT =
  "By default the navigation tools open `http:`, `https:`, `about:blank` and `data:` URLs. " +
  "A `file:` URL needs the `file-io` capability and a path inside $BROWX_WORKSPACE, `javascript:` needs `eval`, and an extension page needs `extensions`. " +
  "The operator opens any other scheme by listing it in `BROWX_NAVIGATE_EXTRA_SCHEMES` in the server's environment (e.g. `chrome,view-source`) and restarting. `set_config` cannot change that list.";

function schemeRefusal(tool: string, error: string, scheme: string, where: string): ToolResponse {
  return jsonResult({
    ok: false,
    action: { type: tool },
    error: `navigation-scheme: ${error}${where}`,
    scheme,
    hint: EXTRA_SCHEMES_HINT,
  });
}

/**
 * Refusal content when `url` may not be opened, else null. `where` is appended
 * to the reason: empty for a requested URL, a note naming the landed URL for
 * one the page ended on.
 */
export function navigationRefusal(
  deps: NavigationSchemeDeps,
  tool: string,
  url: string,
  where = "",
): ToolResponse | null {
  const c = classifyNavigationUrl(url);
  switch (c.kind) {
    case "web":
    case "blank":
    case "data":
      return null;
    case "file": {
      const g = deps.gateCheck(
        tool,
        ["file-io"],
        `a \`file:\` URL reads a local file, which needs \`file-io\`${where}`,
      );
      if (g) return g;
      try {
        resolveWorkspaceReadPath(deps.workspaceRoot, fileURLToPath(url), tool);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return schemeRefusal(
          tool,
          `a \`file:\` URL must name a readable path inside $BROWX_WORKSPACE (${why})`,
          c.scheme,
          where,
        );
      }
      return null;
    }
    case "script":
      return deps.gateCheck(
        tool,
        ["eval"],
        `a \`javascript:\` URL runs script in the page, which needs \`eval\`${where}`,
      );
    case "extension":
      return deps.gateCheck(
        tool,
        ["extensions"],
        `a \`${c.scheme}:\` URL opens an extension page, which needs \`extensions\`${where}`,
      );
    case "other":
      if (!deps.extraSchemes.has(c.scheme)) {
        return schemeRefusal(tool, `\`${c.scheme}:\` URLs are not opened`, c.scheme, where);
      }
      // A wrapping scheme shows another URL's content, so that URL has to pass too.
      return c.inner === undefined ? null : navigationRefusal(deps, tool, c.inner, where);
    case "unparseable":
      return schemeRefusal(
        tool,
        "the URL does not parse; pass an absolute URL with a scheme",
        c.scheme,
        where,
      );
  }
}

/**
 * Check the URL a navigation tool landed on. First the scheme decision: when
 * the landed URL is one the tool would not have opened, the page is sent to
 * `about:blank` so its content cannot be read, and the refusal names the landed
 * URL. Then the origin rules, which leave the page where it is. `requested` is
 * the URL the caller asked for, or empty for a history move. Returns null when
 * the result stands.
 */
export async function checkLanding(
  host: NavigationGateHost,
  tool: string,
  e: SessionEntry,
  requested: string,
  navigation: { changed: boolean; to: string } | undefined,
  deadlineMs: number,
): Promise<ToolResponse | null> {
  const landed = navigation?.changed ? navigation.to : undefined;
  if (!landed) return null;
  const how = requested ? "redirected to" : "landed on";
  const browserPage =
    !opensDeepLinks(host, tool, e) && classifyNavigationUrl(landed).scheme !== BROWSER_ERROR_SCHEME;
  if (browserPage) {
    const shown = redactUrlForLog(landed);
    const deps = schemeDepsOf(host);
    if (navigationRefusal(deps, tool, landed)) {
      const reset = await host.actionsFor(e).navigate({ url: "about:blank", deadlineMs });
      const where = reset.ok
        ? ` (${how} ${shown}; the page was reset to about:blank)`
        : ` (${how} ${shown}; resetting the page to about:blank failed, so it is still there)`;
      return navigationRefusal(deps, tool, landed, where);
    }
  }
  const after = await confirmLanding(requested, landed, host.confirmCtxFor(e));
  if (after.ok) return null;
  return host.denyContent(tool, {
    reason: `${after.reason} (${how} ${landed}; the page stays there)`,
  });
}
