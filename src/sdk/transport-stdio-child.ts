// Stdio-child transport: spawn the `browxai` CLI as a subprocess and speak
// MCP-over-stdio to it via the MCP SDK's `StdioClientTransport`. Owns the
// child lifecycle — `close()` ends the subprocess.
//
// This is the right transport when the caller wants OS-level process
// isolation (e.g. crash containment, capability isolation via per-child
// env). Egress hygiene + capability gates still hold: the child runs the
// SAME server code path; the wire just carries the post-sanitisation
// content array.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseEnvelope, type SdkTransport } from "./transport.js";
import { registerTransport } from "./transport-registry.js";
import type { BrowxaiContentItem, BrowxaiResult } from "./types.js";
import { NAME, VERSION } from "../server.js";

export interface StdioChildOptions {
  /** Defaults to "browxai" — the bin entrypoint. Override for local dev. */
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  /** Optional cwd for the spawned child. */
  readonly cwd?: string;
}

export async function openStdioChildTransport(opts: StdioChildOptions = {}): Promise<SdkTransport> {
  const transport = new StdioClientTransport({
    command: opts.command ?? "browxai",
    args: opts.args ? [...opts.args] : [],
    env: opts.env,
    cwd: opts.cwd,
    // Surface child stderr to the parent so a misconfiguration is visible.
    stderr: "inherit",
  });
  const client = new Client({ name: `${NAME}-sdk`, version: VERSION }, { capabilities: {} });
  await client.connect(transport);
  let closed = false;

  const dispatch = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<BrowxaiResult> => {
    if (closed) throw new Error(`browxai-sdk: dispatch on a closed transport (tool=${toolName})`);
    const res = await client.callTool({ name: toolName, arguments: args });
    const content = (res.content as BrowxaiContentItem[]) ?? [];
    return parseEnvelope(content);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => undefined);
  };

  return { dispatch, close };
}

// RFC 0004 P4 / D6 — self-register under the "stdio-child" mode. The factory maps
// the SDK options to this opener's argument shape EXACTLY as the old
// `case "stdio-child"` arm did (`{ command, args, env }`).
registerTransport("stdio-child", {
  open: (opts) =>
    openStdioChildTransport({ command: opts.command, args: opts.args, env: opts.env }),
});
