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

const callerOf = async (
  plugins: MakePluginOpts[],
  decl: string[],
  tool: string,
): Promise<Record<string, unknown>> => {
  for (const plugin of plugins) makePlugin(workspaceRoot, plugin);
  writeDecl(workspaceRoot, decl);
  const r = await startPluginRuntime({
    workspaceRoot,
    enabledCapabilities: new Set(["read"] as never),
    host: makeHost(host),
  });
  expect(r.plugins.every((p) => p.status === "loaded")).toBe(true);
  const result = await host.tools.get(tool)!.handler({});
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
};

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
});

describe("startPluginRuntime — namespace enforcement", () => {
  it.each<{
    label: string;
    plugin: Partial<MakePluginOpts> & { name: string };
    reason: RegExp;
  }>([
    {
      label: "an invalid manifest",
      plugin: { name: "bad-plugin", namespace: "Bad-NS!", source: "export function register() {}" },
      reason: /namespace/,
    },
    {
      label: "an unnamespaced tool registration at registerTool time",
      plugin: {
        name: "plugin-bad",
        namespace: "bad",
        source: `
          export function register(api) {
            api.registerTool("notNamespaced", { description: "x" }, async () => ({content:[]}));
          }
        `,
      },
      reason: /namespace prefix is mandatory/,
    },
    {
      label: "a plugin with an incompatible apiVersion",
      plugin: {
        name: "plugin-future",
        namespace: "future",
        apiVersion: "2.0.0",
        source: "export function register(){}",
      },
      reason: /apiVersion/,
    },
  ])("rejects $label", async ({ plugin, reason }) => {
    makePlugin(workspaceRoot, { namespace: plugin.name, source: "", ...plugin });
    writeDecl(workspaceRoot, [plugin.name]);
    const r = await startPluginRuntime({
      workspaceRoot,
      enabledCapabilities: new Set(["read"] as never),
      host: makeHost(host),
    });
    expect(r.plugins[0]?.status).toBe("load-error");
    expect(r.plugins[0]?.statusReason).toMatch(reason);
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
    expect(r.plugins[0]?.statusReason).toContain(
      "BROWX_CAPABILITIES=read,navigation,action,human,secrets",
    );
  });
});

describe("startPluginRuntime — call graph enforcement", () => {
  const calls = (target: string) => `
    export function register(api) {
      api.registerTool("b.call", { description: "x" }, async () => {
        return await api.callTool(${JSON.stringify(target)});
      });
    }
  `;
  const pluginA: MakePluginOpts = {
    name: "plugin-a",
    namespace: "a",
    source: `
      export function register(api) {
        api.registerTool("a.hello", { description: "x" }, async () => ({
          content: [{type:"text", text: JSON.stringify({ok:true, who:"a"})}],
        }));
      }
    `,
  };

  it("rejects a plugin calling an undeclared dep at runtime", async () => {
    // b does NOT declare a in dependsOn, so the cross-call must be rejected.
    const parsed = await callerOf(
      [pluginA, { name: "plugin-b", namespace: "b", source: calls("a.hello") }],
      ["plugin-a", "plugin-b"],
      "b.call",
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(PLUGIN_CALL_GRAPH_VIOLATION);
    expect(parsed.fromPlugin).toBe("plugin-b");
    expect(parsed.targetPlugin).toBe("plugin-a");
    expect(parsed.error).toMatch(/plugin call-graph violation/);
  });

  it("rejects a call to an unknown tool", async () => {
    const parsed = await callerOf(
      [{ name: "plugin-b", namespace: "b", source: calls("nonexistent.tool") }],
      ["plugin-b"],
      "b.call",
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(PLUGIN_CALL_GRAPH_VIOLATION);
  });

  it.each<{
    label: string;
    plugins: MakePluginOpts[];
    expected: Record<string, unknown>;
  }>([
    {
      label: "a cross-plugin call when the dep is declared",
      plugins: [
        pluginA,
        {
          name: "plugin-b",
          namespace: "b",
          dependsOn: [{ plugin: "plugin-a", version: "^1.0.0" }],
          source: calls("a.hello"),
        },
      ],
      expected: { ok: true, who: "a" },
    },
    {
      label: "a plugin to call a core tool",
      plugins: [{ name: "plugin-b", namespace: "b", source: calls("snapshot") }],
      expected: { ok: true, core: "snapshot" },
    },
    {
      label: "a plugin to call its OWN tools",
      plugins: [
        {
          name: "plugin-b",
          namespace: "b",
          source: `
            export function register(api) {
              api.registerTool("b.helper", { description: "h" }, async () => ({
                content: [{type:"text", text: JSON.stringify({ok:true, helper:true})}],
              }));
              api.registerTool("b.call", { description: "m" }, async () => {
                return await api.callTool("b.helper");
              });
            }
          `,
        },
      ],
      expected: { helper: true },
    },
  ])("allows $label", async ({ plugins, expected }) => {
    const parsed = await callerOf(
      plugins,
      plugins.map((pl) => pl.name),
      "b.call",
    );
    expect(parsed).toMatchObject(expected);
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
    // Even if plugins.json names a path with `../` segments, the
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
