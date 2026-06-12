// Plugin-runtime integration: end-to-end manifest resolution + load +
// call-graph enforcement, against an on-disk tmp workspace populated
// with miniature plugin packages. No browser, no MCP transport.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPluginRuntime, PLUGIN_CALL_GRAPH_VIOLATION } from "./runtime.js";
import type { PluginToolHandler } from "./types.js";

interface MakePluginOpts {
  name: string;
  version?: string;
  namespace: string;
  apiVersion?: string;
  browxaiVersion?: string;
  capabilities?: ReadonlyArray<string>;
  dependsOn?: ReadonlyArray<{ plugin: string; version: string }>;
  /** ESM source for the entry module — must define `export function register(api){...}`. */
  source: string;
}

function makePlugin(workspaceRoot: string, opts: MakePluginOpts): void {
  const root = join(workspaceRoot, "plugins", "node_modules", opts.name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: opts.name,
        version: opts.version ?? "1.0.0",
        type: "module",
        main: "index.js",
        browxai: {
          apiVersion: opts.apiVersion ?? "1.0.0",
          ...(opts.browxaiVersion ? { browxaiVersion: opts.browxaiVersion } : {}),
          namespace: opts.namespace,
          register: "index.js",
          capabilities: opts.capabilities ?? [],
          dependsOn: opts.dependsOn ?? [],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "index.js"), opts.source, "utf8");
}

function writeDecl(workspaceRoot: string, names: ReadonlyArray<string>): void {
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "plugins.json"), JSON.stringify({ plugins: names }, null, 2));
}

interface HostState {
  /** Registered tool names; populated as `registerTool` is called. */
  readonly tools: Map<string, { handler: PluginToolHandler; capability?: string; owner: string }>;
  /** Core tool names — added before the runtime fires. */
  readonly coreTools: Set<string>;
}

function makeHost(state: HostState): Parameters<typeof startPluginRuntime>[0]["host"] {
  return {
    isCoreTool: (n) => state.coreTools.has(n),
    dispatch: async (n, args) => {
      const t = state.tools.get(n);
      if (t) return t.handler(args);
      if (state.coreTools.has(n)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, core: n, args }) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: `unknown ${n}` }) }],
      };
    },
    registerTool: (name, _def, handler, capability, owner) => {
      const entry: { handler: PluginToolHandler; capability?: string; owner: string } = {
        handler,
        owner,
      };
      if (capability !== undefined) entry.capability = capability;
      state.tools.set(name, entry);
    },
    ownerOf: (n) => state.tools.get(n)?.owner,
  };
}

let workspaceRoot: string;
let host: HostState;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "browxai-plugin-test-"));
  host = { tools: new Map(), coreTools: new Set(["snapshot", "click", "fill"]) };
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("startPluginRuntime — basic loading", () => {
  it("returns an empty result when no plugins are declared", async () => {
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read", "navigation", "action", "human"] as never),
      host: makeHost(host),
    });
    expect(r.plugins).toEqual([]);
    expect(r.toolCount).toBe(0);
  });

  it("loads a single plugin and registers its tools", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-a",
      namespace: "a",
      source: `
        export function register(api) {
          api.registerTool("a.echo", { description: "echo" }, async (args) => ({
            content: [{ type: "text", text: JSON.stringify({ ok: true, args }) }],
          }));
        }
      `,
    });
    writeDecl(workspaceRoot, ["plugin-a"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins).toHaveLength(1);
    expect(r.plugins[0]?.status).toBe("loaded");
    expect(r.plugins[0]?.tools).toEqual(["a.echo"]);
    expect(r.toolCount).toBe(1);
    expect(host.tools.has("a.echo")).toBe(true);
  });

  it("surfaces a not-installed plugin as load-error", async () => {
    writeDecl(workspaceRoot, ["missing-plugin"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins).toHaveLength(1);
    expect(r.plugins[0]?.status).toBe("load-error");
    expect(r.plugins[0]?.statusReason).toMatch(/not installed/);
  });

  it("rejects an invalid manifest", async () => {
    const root = join(workspaceRoot, "plugins", "node_modules", "bad-plugin");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "bad-plugin",
        version: "1.0.0",
        browxai: { apiVersion: "1.0.0", namespace: "Bad-NS!", register: "index.js" },
      }),
    );
    writeFileSync(join(root, "index.js"), "export function register() {}");
    writeDecl(workspaceRoot, ["bad-plugin"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("load-error");
    expect(r.plugins[0]?.statusReason).toMatch(/namespace/);
  });
});

describe("startPluginRuntime — namespace enforcement", () => {
  it("rejects an unnamespaced tool registration at registerTool time", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-bad",
      namespace: "bad",
      source: `
        export function register(api) {
          api.registerTool("notNamespaced", { description: "x" }, async () => ({content:[]}));
        }
      `,
    });
    writeDecl(workspaceRoot, ["plugin-bad"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("load-error");
    expect(r.plugins[0]?.statusReason).toMatch(/namespace prefix is mandatory/);
  });

  it("rejects a namespace conflict between two plugins", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-x",
      namespace: "shared",
      source: "export function register(){}",
    });
    makePlugin(workspaceRoot, {
      name: "plugin-y",
      namespace: "shared",
      source: "export function register(){}",
    });
    writeDecl(workspaceRoot, ["plugin-x", "plugin-y"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    const conflict = r.plugins.find((p) => p.status === "disabled-by-namespace-conflict");
    expect(conflict).toBeDefined();
    expect(conflict?.statusReason).toMatch(/already claimed/);
  });
});

describe("startPluginRuntime — capability gate", () => {
  it("disables a plugin whose declared capabilities aren't enabled", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-secrets",
      namespace: "sec",
      capabilities: ["secrets"],
      source: `
        export function register(api) {
          api.registerTool("sec.peek", { description: "x" }, async () => ({content:[]}));
        }
      `,
    });
    writeDecl(workspaceRoot, ["plugin-secrets"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("disabled-by-capability-mismatch");
    expect(r.plugins[0]?.statusReason).toMatch(/RESTART/);
  });
});

describe("startPluginRuntime — call graph enforcement", () => {
  it("rejects a plugin calling an undeclared dep at runtime", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-a",
      namespace: "a",
      source: `
        export function register(api) {
          api.registerTool("a.hello", { description: "x" }, async () => ({
            content: [{type:"text", text: JSON.stringify({ok:true})}],
          }));
        }
      `,
    });
    makePlugin(workspaceRoot, {
      name: "plugin-b",
      namespace: "b",
      // b does NOT declare a in dependsOn → cross-call must be rejected.
      source: `
        export function register(api) {
          api.registerTool("b.callIntoA", { description: "x" }, async () => {
            const res = await api.callTool("a.hello");
            return res;
          });
        }
      `,
    });
    writeDecl(workspaceRoot, ["plugin-a", "plugin-b"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins.every((p) => p.status === "loaded")).toBe(true);
    const handler = host.tools.get("b.callIntoA");
    expect(handler).toBeDefined();
    const result = await handler!.handler({});
    const txt = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(txt) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(PLUGIN_CALL_GRAPH_VIOLATION);
    expect(parsed.fromPlugin).toBe("plugin-b");
    expect(parsed.targetPlugin).toBe("plugin-a");
    expect(parsed.error).toMatch(/plugin call-graph violation/);
  });

  it("allows a cross-plugin call when the dep is declared", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-a",
      namespace: "a",
      source: `
        export function register(api) {
          api.registerTool("a.hello", { description: "x" }, async () => ({
            content: [{type:"text", text: JSON.stringify({ok:true, who:"a"})}],
          }));
        }
      `,
    });
    makePlugin(workspaceRoot, {
      name: "plugin-b",
      namespace: "b",
      dependsOn: [{ plugin: "plugin-a", version: "^1.0.0" }],
      source: `
        export function register(api) {
          api.registerTool("b.callIntoA", { description: "x" }, async () => {
            return await api.callTool("a.hello");
          });
        }
      `,
    });
    writeDecl(workspaceRoot, ["plugin-a", "plugin-b"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins.every((p) => p.status === "loaded")).toBe(true);
    const handler = host.tools.get("b.callIntoA");
    const result = await handler!.handler({});
    const txt = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(txt) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.who).toBe("a");
  });

  it("allows a plugin to call a core tool", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-a",
      namespace: "a",
      source: `
        export function register(api) {
          api.registerTool("a.peek", { description: "x" }, async () => {
            return await api.callTool("snapshot");
          });
        }
      `,
    });
    writeDecl(workspaceRoot, ["plugin-a"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("loaded");
    const handler = host.tools.get("a.peek");
    const result = await handler!.handler({});
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect(parsed.ok).toBe(true);
    expect(parsed.core).toBe("snapshot");
  });

  it("rejects a call to an unknown tool", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-a",
      namespace: "a",
      source: `
        export function register(api) {
          api.registerTool("a.peek", { description: "x" }, async () => {
            return await api.callTool("nonexistent.tool");
          });
        }
      `,
    });
    writeDecl(workspaceRoot, ["plugin-a"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("loaded");
    const handler = host.tools.get("a.peek");
    const result = await handler!.handler({});
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(PLUGIN_CALL_GRAPH_VIOLATION);
  });

  it("allows a plugin to call its OWN tools", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-a",
      namespace: "a",
      source: `
        export function register(api) {
          api.registerTool("a.helper", { description: "h" }, async () => ({
            content: [{type:"text", text: JSON.stringify({ok:true, helper:true})}],
          }));
          api.registerTool("a.main", { description: "m" }, async () => {
            return await api.callTool("a.helper");
          });
        }
      `,
    });
    writeDecl(workspaceRoot, ["plugin-a"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("loaded");
    const handler = host.tools.get("a.main");
    const result = await handler!.handler({});
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect(parsed.helper).toBe(true);
  });
});

describe("startPluginRuntime — dep-graph cycles", () => {
  it("aborts startup on a two-plugin cycle", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-a",
      namespace: "a",
      dependsOn: [{ plugin: "plugin-b", version: "^1.0.0" }],
      source: "export function register(){}",
    });
    makePlugin(workspaceRoot, {
      name: "plugin-b",
      namespace: "b",
      dependsOn: [{ plugin: "plugin-a", version: "^1.0.0" }],
      source: "export function register(){}",
    });
    writeDecl(workspaceRoot, ["plugin-a", "plugin-b"]);
    await expect(
      startPluginRuntime({
        workspaceRoot,
        enabledCapabilities: new Set(["read"] as never),
        host: makeHost(host),
      }),
    ).rejects.toThrow(/cycle/i);
  });
});

describe("startPluginRuntime — apiVersion + dep-version checks", () => {
  it("rejects a plugin with incompatible apiVersion", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-future",
      namespace: "future",
      apiVersion: "2.0.0",
      source: "export function register(){}",
    });
    writeDecl(workspaceRoot, ["plugin-future"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("load-error");
    expect(r.plugins[0]?.statusReason).toMatch(/apiVersion/);
  });

  it("warns (but still loads) on a browxaiVersion range the host doesn't satisfy", async () => {
    const { log } = await import("../util/logging.js");
    const { PACKAGE_VERSION } = await import("../util/version.js");
    const warnSpy = vi.spyOn(log, "warn");
    makePlugin(workspaceRoot, {
      name: "plugin-old-range",
      namespace: "oldrange",
      browxaiVersion: "^0.0.1",
      source: "export function register(){}",
    });
    writeDecl(workspaceRoot, ["plugin-old-range"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    // Advisory only: the plugin loads anyway.
    expect(r.plugins[0]?.status).toBe("loaded");
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toMatch(/plugin-old-range/);
    expect(warned).toMatch(/advisory/);
    expect(warned).toContain(PACKAGE_VERSION);
    warnSpy.mockRestore();
  });

  it("does not warn when the host satisfies browxaiVersion", async () => {
    const { log } = await import("../util/logging.js");
    const { PACKAGE_VERSION } = await import("../util/version.js");
    const warnSpy = vi.spyOn(log, "warn");
    makePlugin(workspaceRoot, {
      name: "plugin-good-range",
      namespace: "goodrange",
      browxaiVersion: `^${PACKAGE_VERSION}`,
      source: "export function register(){}",
    });
    writeDecl(workspaceRoot, ["plugin-good-range"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("loaded");
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toMatch(/browxaiVersion/);
    warnSpy.mockRestore();
  });

  it("disables a plugin whose dep version range isn't satisfied", async () => {
    makePlugin(workspaceRoot, {
      name: "plugin-a",
      version: "0.5.0",
      namespace: "a",
      source: "export function register(){}",
    });
    makePlugin(workspaceRoot, {
      name: "plugin-b",
      namespace: "b",
      dependsOn: [{ plugin: "plugin-a", version: "^1.0.0" }],
      source: "export function register(){}",
    });
    writeDecl(workspaceRoot, ["plugin-a", "plugin-b"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    const b = r.plugins.find((p) => p.manifest.name === "plugin-b");
    expect(b?.status).toBe("disabled-by-dep-missing");
    expect(b?.statusReason).toMatch(/does not satisfy/);
  });
});

describe("startPluginRuntime — workspace escape attempts", () => {
  it("does not traverse outside the workspace's plugin dir", async () => {
    // Even if plugins.json names something with path traversal, the
    // resolver only joins against the install dir → never escapes.
    writeDecl(workspaceRoot, ["../../etc-passwd"]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("load-error");
    expect(r.plugins[0]?.statusReason).toMatch(/not installed/);
  });
});
