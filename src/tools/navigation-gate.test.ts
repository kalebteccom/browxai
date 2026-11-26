// The scheme and landing checks of navigate / go_back / go_forward, browser-free.
// `navigationRefusal` runs against three plain values; the three handlers run
// against a stub host whose action port returns canned ActionResults, so each
// case states which URL was requested, which one the page ended on, and what
// came back.

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { resolveOriginPolicy } from "../policy/origin.js";
import { registerActionCoreTools } from "./action-core-tools.js";
import { registerActionHistoryTools } from "./action-history-tools.js";
import { navigationRefusal, type NavigationSchemeDeps } from "./navigation-gate.js";
import type { ToolResponse } from "./host.js";

type Body = Record<string, unknown>;
type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

// realpath: the OS temp dir is a link on macOS, and the workspace check compares real paths.
const root = realpathSync(mkdtempSync(join(tmpdir(), "browxai-nav-gate-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "browxai-nav-gate-outside-")));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
writeFileSync(join(root, "page.html"), "<p>inside</p>");
writeFileSync(join(outside, "page.html"), "<p>outside</p>");
mkdirSync(join(root, "profile"));
writeFileSync(join(root, "profile", "Cookies"), "");
symlinkSync(join(outside, "page.html"), join(root, "link.html"));

const inside = pathToFileURL(join(root, "page.html")).href;
const outsideUrl = pathToFileURL(join(outside, "page.html")).href;

const bodyOf = (res: ToolResponse | null): Body =>
  JSON.parse((res!.content[0] as { text: string }).text) as Body;

/** The real gate's compound arm, reduced to what a caller keys on. */
const gateCheckWith =
  (caps: readonly string[]) =>
  (toolName: string, extra?: readonly string[], reason?: string): ToolResponse | null => {
    const missing = (extra ?? []).find((c) => !caps.includes(c));
    if (!missing) return null;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, tool: toolName, requiredCapability: missing, reason }),
        },
      ],
    };
  };

const depsWith = (
  caps: readonly string[],
  extra: readonly string[] = [],
): NavigationSchemeDeps => ({
  gateCheck: gateCheckWith(caps),
  workspaceRoot: root,
  extraSchemes: new Set(extra),
});

describe("navigationRefusal", () => {
  it.each([
    "https://app.example.com/",
    "http://127.0.0.1:3000/x",
    "about:blank",
    "data:text/html,<p>hi</p>",
  ])("opens %s with no capability and no extra scheme", (url) => {
    expect(navigationRefusal(depsWith([]), "navigate", url)).toBeNull();
  });

  it.each([
    [inside, "file-io"],
    ["FILE:///etc/hosts", "file-io"],
    ["javascript:void 0", "eval"],
    ["chrome-extension://abcdefghijklmnop/popup.html", "extensions"],
  ])("refuses %s without %s, on the capability envelope", (url, capability) => {
    const body = bodyOf(navigationRefusal(depsWith([]), "navigate", url));
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe(capability);
    expect(body.reason).toContain(`\`${capability}\``);
  });

  it("opens a workspace file with file-io", () => {
    expect(navigationRefusal(depsWith(["file-io"]), "navigate", inside)).toBeNull();
    expect(navigationRefusal(depsWith(["file-io"]), "navigate", `${inside}?a=1#top`)).toBeNull();
  });

  it.each([
    ["a path outside the workspace", outsideUrl],
    ["a system file", "file:///etc/hosts"],
    ["a workspace link that points outside", pathToFileURL(join(root, "link.html")).href],
    ["a browser profile file", pathToFileURL(join(root, "profile", "Cookies")).href],
    ["a dot-dot path that leaves the workspace", `${pathToFileURL(root).href}/../x.html`],
    ["a file URL with a remote host", "file://files.example.com/share/a.html"],
  ])("refuses %s with file-io on", (_label, url) => {
    const body = bodyOf(navigationRefusal(depsWith(["file-io"]), "navigate", url));
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBeUndefined();
    expect(body.scheme).toBe("file");
    expect(body.error).toMatch(/^navigation-scheme: a `file:` URL must name a readable path/);
    expect(body.action).toEqual({ type: "navigate" });
  });

  it("opens javascript: with eval and an extension page with extensions", () => {
    expect(navigationRefusal(depsWith(["eval"]), "navigate", "javascript:void 0")).toBeNull();
    expect(
      navigationRefusal(depsWith(["extensions"]), "navigate", "chrome-extension://abcdefgh/p.html"),
    ).toBeNull();
  });

  it.each([
    ["chrome://version", "chrome"],
    ["view-source:https://app.example.com/", "view-source"],
    ["about:config", "about"],
    ["blob:https://app.example.com/0f8b", "blob"],
    ["ftp://files.example.com/a.txt", "ftp"],
  ])("refuses %s by default and names the scheme", (url, scheme) => {
    // Every capability on: no capability opens these.
    const body = bodyOf(
      navigationRefusal(depsWith(["file-io", "eval", "extensions"]), "navigate", url),
    );
    expect(body.ok).toBe(false);
    expect(body.scheme).toBe(scheme);
    expect(body.error).toBe(`navigation-scheme: \`${scheme}:\` URLs are not opened`);
    expect(body.hint).toContain("BROWX_NAVIGATE_EXTRA_SCHEMES");
    expect(body.requiredCapability).toBeUndefined();
  });

  it("refuses an unparseable URL", () => {
    for (const url of ["", "app.example.com/login"]) {
      const body = bodyOf(navigationRefusal(depsWith([]), "navigate", url));
      expect(body.error).toMatch(/^navigation-scheme: the URL does not parse/);
    }
  });

  it("opens a scheme the operator listed", () => {
    const deps = depsWith([], ["chrome", "view-source"]);
    expect(navigationRefusal(deps, "navigate", "chrome://version")).toBeNull();
    expect(navigationRefusal(deps, "navigate", "view-source:https://app.example.com/")).toBeNull();
    expect(bodyOf(navigationRefusal(deps, "navigate", "devtools://devtools/x")).scheme).toBe(
      "devtools",
    );
  });

  it("applies the rules to the URL inside view-source:", () => {
    const listed = ["view-source"];
    expect(
      bodyOf(navigationRefusal(depsWith([], listed), "navigate", "view-source:file:///etc/hosts"))
        .requiredCapability,
    ).toBe("file-io");
    expect(
      bodyOf(
        navigationRefusal(depsWith(["file-io"], listed), "navigate", `view-source:${outsideUrl}`),
      ).scheme,
    ).toBe("file");
    expect(
      navigationRefusal(depsWith(["file-io"], listed), "navigate", `view-source:${inside}`),
    ).toBeNull();
    expect(
      bodyOf(navigationRefusal(depsWith([], listed), "navigate", "view-source:chrome://version"))
        .scheme,
    ).toBe("chrome");
  });

  it("names the calling tool and appends the landing note", () => {
    const body = bodyOf(
      navigationRefusal(
        depsWith([]),
        "go_back",
        "chrome://version",
        " (landed on chrome://version)",
      ),
    );
    expect(body.action).toEqual({ type: "go_back" });
    expect(body.error).toBe(
      "navigation-scheme: `chrome:` URLs are not opened (landed on chrome://version)",
    );
  });
});

// ---- the three handlers ----------------------------------------------------

interface Stub {
  handlers: Record<string, Handler>;
  /** URLs the action port was asked to load, in order. */
  loaded: string[];
  historyMoves: string[];
}

interface StubOpts {
  caps?: readonly string[];
  extraSchemes?: readonly string[];
  /** Where the page ends up after the next navigate / history move. */
  landsOn?: string;
  /** Origin allowlist; with it set the off-allowlist hook is on and no human can answer. */
  allowedOrigins?: string;
  resetFails?: boolean;
  /** The engine declares no web `storage`: a native-app engine. */
  nativeApp?: boolean;
}

function stubHost(opts: StubOpts = {}): Stub {
  const handlers: Record<string, Handler> = {};
  const loaded: string[] = [];
  const historyMoves: string[] = [];
  const result = (type: string, to: string, ok = true) => ({
    ok,
    action: { type },
    navigation: { changed: true, from: "https://start.example/", to, kind: "full_load" },
  });
  const entry = { id: "s1", refs: {}, session: { engine: "stub" } };
  const host = {
    z,
    register: (name: string, _def: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
    gateCheck: gateCheckWith(opts.caps ?? []),
    engineGate: () => null,
    subInterfaceGate: (): ToolResponse | null =>
      opts.nativeApp ? { content: [{ type: "text", text: '{"ok":false}' }] } : null,
    entryFor: async () => entry,
    confirmCtxFor: () => ({
      hooks: new Set(opts.allowedOrigins ? ["navigate_off_allowlist"] : []),
      policy: resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: opts.allowedOrigins }),
      bridge: null,
      isByob: false,
      sessionId: "s1",
    }),
    denyContent: (toolName: string, decision: { reason: string }): ToolResponse => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            action: { type: toolName },
            error: `policy: ${decision.reason}`,
          }),
        },
      ],
    }),
    actionTimeout: () => ({ ms: 1_000 }),
    actionsFor: () => ({
      navigate: async ({ url }: { url: string }) => {
        loaded.push(url);
        if (url === "about:blank" && loaded.length > 1) {
          return result("navigate", url, !opts.resetFails);
        }
        return result("navigate", opts.landsOn ?? url);
      },
      goBack: async () => {
        historyMoves.push("back");
        return result("goBack", opts.landsOn ?? "https://start.example/prev");
      },
      goForward: async () => {
        historyMoves.push("forward");
        return result("goForward", opts.landsOn ?? "https://start.example/next");
      },
    }),
    asActionResultText: async (p: Promise<unknown>): Promise<ToolResponse> => ({
      content: [{ type: "text", text: JSON.stringify(await p, null, 2) }],
    }),
    workspace: { root },
    navigateExtraSchemes: new Set(opts.extraSchemes ?? []),
  };
  registerActionCoreTools(host as never);
  registerActionHistoryTools(host as never);
  return { handlers, loaded, historyMoves };
}

const run = async (stub: Stub, tool: string, args: Body = {}): Promise<Body> =>
  bodyOf(await stub.handlers[tool]!(args));

describe("navigate", () => {
  it("loads a web URL and returns the ActionResult", async () => {
    const stub = stubHost();
    const body = await run(stub, "navigate", { url: "https://app.example.com/" });
    expect(body.ok).toBe(true);
    expect(stub.loaded).toEqual(["https://app.example.com/"]);
  });

  it.each([
    [inside, "file-io"],
    ["javascript:void 0", "eval"],
    ["moz-extension://0a1b2c3d/popup.html", "extensions"],
  ])("refuses %s before the page is touched, naming %s", async (url, capability) => {
    const stub = stubHost();
    const body = await run(stub, "navigate", { url });
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe(capability);
    expect(stub.loaded).toEqual([]);
  });

  it.each(["chrome://version", "view-source:https://app.example.com/", "not a url"])(
    "refuses %s before the page is touched",
    async (url) => {
      const stub = stubHost({ caps: ["file-io", "eval", "extensions"] });
      const body = await run(stub, "navigate", { url });
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/^navigation-scheme: /);
      expect(stub.loaded).toEqual([]);
    },
  );

  it("loads a workspace file with file-io, and refuses one outside it", async () => {
    const stub = stubHost({ caps: ["file-io"] });
    expect((await run(stub, "navigate", { url: inside })).ok).toBe(true);
    const body = await run(stub, "navigate", { url: outsideUrl });
    expect(body.ok).toBe(false);
    expect(body.scheme).toBe("file");
    expect(stub.loaded).toEqual([inside]);
  });

  it("loads a listed scheme", async () => {
    const stub = stubHost({ extraSchemes: ["chrome"] });
    expect((await run(stub, "navigate", { url: "chrome://version" })).ok).toBe(true);
  });

  it("opens a deep link on a native-app engine, whatever its scheme", async () => {
    const stub = stubHost({ nativeApp: true });
    const body = await run(stub, "navigate", { url: "myapp://checkout/42" });
    expect(body.ok).toBe(true);
    // The engine reports the deep link as the landed URL; nothing is reset.
    expect(stub.loaded).toEqual(["myapp://checkout/42"]);
  });

  it("refuses the same custom scheme on a browser engine", async () => {
    const stub = stubHost();
    const body = await run(stub, "navigate", { url: "myapp://checkout/42" });
    expect(body.scheme).toBe("myapp");
    expect(stub.loaded).toEqual([]);
  });

  it("resets the page when a load lands on a scheme it would not open", async () => {
    const stub = stubHost({ landsOn: "file:///etc/hosts" });
    const body = await run(stub, "navigate", { url: "https://app.example.com/go" });
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("file-io");
    expect(body.reason).toContain(
      "(redirected to file:///etc/hosts; the page was reset to about:blank)",
    );
    expect(stub.loaded).toEqual(["https://app.example.com/go", "about:blank"]);
  });

  it("says so when the reset fails", async () => {
    const stub = stubHost({ landsOn: "chrome://settings/", resetFails: true });
    const body = await run(stub, "navigate", { url: "https://app.example.com/go" });
    expect(body.error).toContain("resetting the page to about:blank failed");
  });

  it("leaves the browser's own error page for the ActionResult to report", async () => {
    const stub = stubHost({ landsOn: "chrome-error://chromewebdata/" });
    const body = await run(stub, "navigate", { url: "https://down.example.com/" });
    expect(body.error).toBeUndefined();
    expect(stub.loaded).toEqual(["https://down.example.com/"]);
  });

  it("still holds a redirect to an off-allowlist origin, and leaves the page there", async () => {
    const stub = stubHost({
      allowedOrigins: "https://app.example.com",
      landsOn: "https://other.example.net/x",
    });
    const body = await run(stub, "navigate", { url: "https://app.example.com/go" });
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(
      /^policy: .*redirected to https:\/\/other\.example\.net\/x; the page stays there/,
    );
    expect(stub.loaded).toEqual(["https://app.example.com/go"]);
  });
});

describe.each([
  ["go_back", "back"],
  ["go_forward", "forward"],
])("%s", (tool, move) => {
  it("returns the ActionResult for a web landing with no allowlist", async () => {
    const stub = stubHost();
    const body = await run(stub, tool);
    expect(body.ok).toBe(true);
    expect(stub.historyMoves).toEqual([move]);
    expect(stub.loaded).toEqual([]);
  });

  it("holds a landing on an off-allowlist origin, and leaves the page there", async () => {
    const stub = stubHost({
      allowedOrigins: "https://app.example.com",
      landsOn: "https://other.example.net/x",
    });
    const body = await run(stub, tool);
    expect(body.ok).toBe(false);
    expect(body.action).toEqual({ type: tool });
    expect(body.error).toMatch(
      /^policy: .*landed on https:\/\/other\.example\.net\/x; the page stays there/,
    );
    expect(stub.loaded).toEqual([]);
  });

  it("passes a landing on an allowlisted origin", async () => {
    const stub = stubHost({
      allowedOrigins: "https://app.example.com",
      landsOn: "https://app.example.com/prev",
    });
    expect((await run(stub, tool)).ok).toBe(true);
  });

  it("passes a landing on about:blank", async () => {
    const stub = stubHost({ allowedOrigins: "https://app.example.com", landsOn: "about:blank" });
    expect((await run(stub, tool)).ok).toBe(true);
  });

  it("resets the page when it lands on a file: URL without file-io", async () => {
    const stub = stubHost({ landsOn: inside });
    const body = await run(stub, tool);
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("file-io");
    expect(body.reason).toContain("the page was reset to about:blank");
    expect(stub.loaded).toEqual(["about:blank"]);
  });

  it("resets the page when it lands on a scheme no capability opens", async () => {
    const stub = stubHost({ caps: ["file-io"], landsOn: "chrome://settings/" });
    const body = await run(stub, tool);
    expect(body.error).toBe(
      "navigation-scheme: `chrome:` URLs are not opened (landed on chrome://settings/; the page was reset to about:blank)",
    );
    expect(stub.loaded).toEqual(["about:blank"]);
  });

  it("stays on a workspace file with file-io", async () => {
    const stub = stubHost({ caps: ["file-io"], landsOn: inside });
    expect((await run(stub, tool)).ok).toBe(true);
    expect(stub.loaded).toEqual([]);
  });
});
