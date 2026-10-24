import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { warnNonFirstPartyPlugins, wirePluginRuntime } from "./plugin-runtime.js";
import type { ToolHost } from "./host.js";
import { log } from "../util/logging.js";
import { SecretRegistry } from "../util/secrets.js";
import type { PluginRecord } from "../plugin/types.js";
import type { TrustTier } from "../plugin/manifest.js";

function record(name: string, trust: TrustTier, capabilities: string[] = []): PluginRecord {
  return {
    manifest: {
      name,
      version: "1.0.0",
      path: `/tmp/${name}`,
      entryPath: `/tmp/${name}/index.js`,
      trust,
      browxai: {
        apiVersion: "1.0.0",
        namespace: name.replace(/[^a-z]/g, ""),
        register: "index.js",
        capabilities,
        dependsOn: [],
      },
    },
    status: "loaded",
    tools: [],
    transitiveDeps: [],
    declaredCapabilities: capabilities,
    declaredAt: "plugins.json",
  } as unknown as PluginRecord;
}

afterEach(() => vi.restoreAllMocks());

describe("warnNonFirstPartyPlugins", () => {
  it("stays silent when every loaded plugin is first-party", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    warnNonFirstPartyPlugins([record("@browxai/plugin-a", "kalebtec", ["eval"])]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("names each community plugin with its declared capabilities", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    warnNonFirstPartyPlugins([
      record("@browxai/plugin-first", "kalebtec"),
      record("browxai-plugin-third", "community", ["eval", "file-io"]),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0];
    expect(msg).toContain("1 non-first-party plugin(s)");
    expect(msg).toContain("browxai-plugin-third@1.0.0 [community]");
    expect(msg).toContain("eval, file-io");
    expect(msg).not.toContain("plugin-first");
  });

  it("says so explicitly when a plugin declared no capabilities", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    warnNonFirstPartyPlugins([record("local-dev-plugin", "local")]);
    const msg = warn.mock.calls[0]![0];
    expect(msg).toContain("[local]");
    expect(msg).toContain("none declared");
  });
});

describe("wirePluginRuntime — declared parameters over MCP", () => {
  let workspaceRoot: string;
  let server: McpServer;
  let client: Client;

  const ENTRY = `
    const echoArgs = async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] });
    export function register(api) {
      api.registerTool("tst.echo", {
        description: "Echo the declared arguments.",
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string", description: "text to echo" } },
          required: ["msg"],
        },
      }, echoArgs);
      api.registerTool("tst.bare", { description: "Declares nothing.", inputSchema: {} }, echoArgs);
      api.registerTool("tst.boom", { description: "Throws.", inputSchema: {} }, async () => {
        throw new Error("plugin saw hunter2");
      });
      api.registerTool("tst.loose", {
        description: "Keeps undeclared keys.",
        inputSchema: {
          type: "object",
          properties: { kind: { type: "string" } },
          additionalProperties: true,
        },
      }, echoArgs);
    }
  `;

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "browxai-plugin-wire-"));
    const pluginDir = join(workspaceRoot, "plugins", "node_modules", "tst-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "tst-plugin",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        browxai: {
          apiVersion: "1.0.0",
          namespace: "tst",
          register: "index.js",
          capabilities: [],
          dependsOn: [],
        },
      }),
    );
    writeFileSync(join(pluginDir, "index.js"), ENTRY);
    writeFileSync(join(workspaceRoot, "plugins.json"), JSON.stringify({ plugins: ["tst-plugin"] }));

    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    server = new McpServer({ name: "wire-test", version: "0.0.0" });
    const host = {
      register: vi.fn(),
      gateCheck: () => null,
      caps: { enabled: new Set(["read", "navigation", "action", "human"]) },
      workspace: { root: workspaceRoot },
      resolvedConfig: { plugins: [] },
      toolHandlers: {},
      z,
    } as unknown as ToolHost;
    await wirePluginRuntime(host, {
      server,
      noteMetrics: () => undefined,
      noteDiagnostics: () => undefined,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "wire-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const textOf = (res: Awaited<ReturnType<Client["callTool"]>>): string =>
    ((res.content as Array<{ text: string }>)[0] as { text: string }).text;

  it.each([
    {
      label: "delivers a declared argument to the handler",
      tool: "tst.echo",
      args: { msg: "hi" },
      expected: { msg: "hi" },
    },
    {
      label: "drops keys the declaration does not name",
      tool: "tst.echo",
      args: { msg: "hi", extra: 1 },
      expected: { msg: "hi" },
    },
    {
      label: "keeps undeclared keys when the declaration sets additionalProperties",
      tool: "tst.loose",
      args: { kind: "box", width: 3 },
      expected: { kind: "box", width: 3 },
    },
    {
      label: "keeps an undeclared tool argless",
      tool: "tst.bare",
      args: { msg: "hi" },
      expected: {},
    },
  ])("$label", async ({ tool, args, expected }) => {
    const res = await client.callTool({ name: tool, arguments: args });
    expect(JSON.parse(textOf(res))).toEqual(expected);
  });

  it("refuses a call that omits a required argument", async () => {
    const res = await client.callTool({ name: "tst.echo", arguments: {} });
    expect(res.isError).toBe(true);
  });

  it("lists the declared parameters on tools/list", async () => {
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "tst.echo");
    expect(echo?.inputSchema.properties).toHaveProperty("msg");
    expect(echo?.inputSchema.required).toEqual(["msg"]);
  });
});

describe("wirePluginRuntime — plugin tool output masks registered secrets", () => {
  let workspaceRoot: string;

  afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  async function wire(secretsOn: boolean): Promise<{
    handlers: Record<string, (args: unknown) => Promise<{ content: Array<{ text?: string }> }>>;
    seen: string[];
  }> {
    workspaceRoot = mkdtempSync(join(tmpdir(), "browxai-plugin-mask-"));
    const pluginDir = join(workspaceRoot, "plugins", "node_modules", "msk-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "msk-plugin",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        browxai: {
          apiVersion: "1.0.0",
          namespace: "msk",
          register: "index.js",
          capabilities: [],
          dependsOn: [],
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "index.js"),
      `export function register(api) {
        api.registerTool("msk.echo", { description: "e", inputSchema: { type: "object", additionalProperties: true } },
          async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }));
        api.registerTool("msk.boom", { description: "b", inputSchema: {} }, async () => {
          throw new Error("plugin saw hunter2");
        });
      }`,
    );
    writeFileSync(join(workspaceRoot, "plugins.json"), JSON.stringify({ plugins: ["msk-plugin"] }));
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    const toolHandlers = {};
    const seen: string[] = [];
    const host = {
      register: vi.fn(),
      gateCheck: () => null,
      caps: {
        enabled: new Set([
          "read",
          "navigation",
          "action",
          "human",
          ...(secretsOn ? ["secrets"] : []),
        ]),
      },
      workspace: { root: workspaceRoot },
      resolvedConfig: { plugins: [] },
      registry: { list: () => [{ secrets }] },
      toolHandlers,
      z,
    } as unknown as ToolHost;
    await wirePluginRuntime(host, {
      server: new McpServer({ name: "mask-test", version: "0.0.0" }),
      noteMetrics: (_n, _a, res) => {
        seen.push(JSON.stringify(res));
      },
      noteDiagnostics: () => undefined,
    });
    return { handlers: toolHandlers, seen };
  }

  it("masks a registered value in a plugin result before metrics see it", async () => {
    const { handlers, seen } = await wire(true);
    const res = await handlers["msk.echo"]!({ note: "hunter2" });
    expect(JSON.parse(res.content[0]!.text!)).toEqual({ note: "<PASSWORD>" });
    expect(seen.join("")).not.toContain("hunter2");
  });

  it("masks the message of a plugin tool that throws", async () => {
    const { handlers, seen } = await wire(true);
    const res = await handlers["msk.boom"]!({});
    const text = res.content[0]!.text!;
    expect(text).toContain("<PASSWORD>");
    expect(text).not.toContain("hunter2");
    expect(seen.join("")).not.toContain("hunter2");
  });

  it("leaves plugin results alone when the secrets capability is off", async () => {
    const { handlers } = await wire(false);
    const res = await handlers["msk.echo"]!({ note: "hunter2" });
    expect(JSON.parse(res.content[0]!.text!)).toEqual({ note: "hunter2" });
  });
});
