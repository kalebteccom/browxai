import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowxaiResult, McpClientAdapter } from "./types.js";

const repoRoot = "/Users/rowin/Projects/Kalebtec/browxai";

interface CreateMcpClientOptions {
  readonly workspace: string;
  readonly capabilities: readonly string[];
  readonly headless: boolean;
}

function cleanChildEnv(opts: CreateMcpClientOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("BROWX_") || value === undefined) continue;
    env[key] = value;
  }
  env.BROWX_WORKSPACE = opts.workspace;
  env.BROWX_CAPABILITIES = opts.capabilities.join(",");
  env.BROWX_HEADLESS = opts.headless ? "1" : "0";
  return env;
}

function textData(content: unknown): unknown | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    return undefined;
  }

  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return undefined;
  }
}

export async function createMcpClient(
  opts: CreateMcpClientOptions,
): Promise<McpClientAdapter> {
  const cliPath = join(repoRoot, "dist", "cli.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    env: cleanChildEnv(opts),
    stderr: "ignore",
  });
  const mcp = new McpClient({ name: "capability-testbed", version: "0.0.0" });
  await mcp.connect(transport);
  let closed = false;

  async function callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<BrowxaiResult> {
    if (closed) throw new Error(`capability-testbed MCP client is closed (tool=${name})`);
    const result = await mcp.callTool({ name, arguments: args });
    const content = result.content;
    const isError = typeof result.isError === "boolean" ? result.isError : undefined;
    return {
      content,
      data: textData(content),
      isError,
    };
  }

  return {
    callTool,
    open_session: (args) => callTool("open_session", args),
    close_session: (args) => callTool("close_session", args),
    close_sessions: (args) => callTool("close_sessions", args),
    list_sessions: (args) => callTool("list_sessions", args),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await mcp.close();
      } finally {
        await transport.close().catch(() => undefined);
      }
    },
  };
}
