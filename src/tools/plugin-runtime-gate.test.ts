// The plugin tool wrapper: the capability gate checks every capability the
// plugin declared, and arguments are parsed with the declared schema on every
// caller, the direct ones (`batch`, `api.callTool`, the SDK) included.
//
// The plugin runtime itself skips a plugin whose declared capabilities are not
// all on, so the second-capability refusal is reached here by calling the host's
// `registerTool` hook directly from a stubbed runtime.

import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolHost, ToolResponse } from "./host.js";
import type { RuntimeStartOptions } from "../plugin/host-hooks.js";
import { log } from "../util/logging.js";

type Handler = (args: unknown) => Promise<ToolResponse>;

const seen: unknown[] = [];

vi.mock("../plugin/runtime.js", () => ({
  startPluginRuntime: async (opts: RuntimeStartOptions) => {
    const echo = async (args: unknown) => {
      seen.push(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(args ?? null) }] };
    };
    opts.host.registerTool(
      "two.echo",
      { description: "e", inputSchema: {} },
      echo,
      ["read", "eval"],
      "two",
    );
    opts.host.registerTool(
      "one.echo",
      {
        description: "e",
        inputSchema: {
          type: "object",
          properties: { n: { type: "integer", minimum: 1 } },
          required: ["n"],
        },
      },
      echo,
      ["read"],
      "one",
    );
    opts.host.registerTool(
      "one.loose",
      { description: "e", inputSchema: { type: "object", additionalProperties: true } },
      echo,
      ["read"],
      "one",
    );
    return { plugins: [], toolCount: 3 };
  },
}));

const { wirePluginRuntime } = await import("./plugin-runtime.js");

async function wire(): Promise<Record<string, Handler>> {
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  const toolHandlers: Record<string, Handler> = {};
  const host = {
    register: vi.fn(),
    gateCheck: () => null,
    caps: { enabled: new Set(["read", "navigation", "action", "human"]) },
    workspace: { root: "/nonexistent" },
    resolvedConfig: { plugins: [] },
    registry: { list: () => [] },
    toolHandlers,
    z,
  } as unknown as ToolHost;
  await wirePluginRuntime(host, {
    server: new McpServer({ name: "gate-test", version: "0.0.0" }),
    noteMetrics: () => undefined,
    noteDiagnostics: () => undefined,
  });
  return toolHandlers;
}

const bodyOf = (r: ToolResponse) =>
  JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

describe("plugin tool wrapper", () => {
  it("refuses when the second declared capability is off", async () => {
    seen.length = 0;
    const h = await wire();
    const body = bodyOf(await h["two.echo"]!({}));
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("eval");
    expect(seen).toEqual([]);
  });

  it("refuses arguments that do not match the declared schema, before the handler", async () => {
    seen.length = 0;
    const h = await wire();
    for (const args of [{}, { n: "1" }, { n: 0 }, { n: 1.5 }]) {
      const body = bodyOf(await h["one.echo"]!(args));
      expect(body.ok, JSON.stringify(args)).toBe(false);
      expect(String(body.error)).toMatch(/^one\.echo: the arguments do not match/);
    }
    expect(seen).toEqual([]);
  });

  it("drops undeclared keys, as the MCP wire does", async () => {
    seen.length = 0;
    const h = await wire();
    expect(bodyOf(await h["one.echo"]!({ n: 2, extra: "x" }))).toEqual({ n: 2 });
  });

  it("keeps undeclared keys when the declaration sets additionalProperties", async () => {
    const h = await wire();
    expect(bodyOf(await h["one.loose"]!({ kind: "box", w: 3 }))).toEqual({ kind: "box", w: 3 });
  });
});
