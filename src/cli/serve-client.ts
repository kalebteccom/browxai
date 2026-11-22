// The MCP server one attached socket client talks to. Each connection to
// `browxai serve --socket` gets its own, and all of them route to the shared handler
// maps of one `createServer` result, so session state stays in the session registry.
//
// We deliberately do NOT use the high-level `McpServer.registerTool` with per-tool
// schemas: that path validates and strips arguments against the declared schema, and an
// empty schema dropped every argument (the `navigate`-hangs-forever bug). The low-level
// CallTool handler forwards raw arguments, exactly like the in-process transport
// (`src/sdk/transport-in-process.ts`). The per-tool handler does its own validation.

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { NAME, VERSION, type createServer } from "../server.js";
import { listedTool } from "./serve-listing.js";

/** What a client connection needs from `createServer`'s result. */
export type ClientHandlers = Pick<
  Awaited<ReturnType<typeof createServer>>,
  "handlers" | "wireHandlers" | "isToolListed" | "registrations"
>;

/** A new MCP server for one client connection, not yet connected to a transport. */
export function createClientServer(browxai: ClientHandlers): McpServer {
  const mcp = new McpServer({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });
  // One-line descriptions and the capability of each tool, so `browxai tools` can print
  // them. The input schema stays open (see `listedTool`).
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.keys(browxai.handlers)
      .filter((name) => browxai.isToolListed(name))
      .map((name) => listedTool(name, browxai.registrations.get(name))),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    // The wire form masks a thrown error's message for registered secrets, as the stdio
    // server does. `handlers` throws, so an error message would skip the mask. A plugin
    // tool has no wire entry and catches its own errors.
    // Own properties only: the maps are plain objects, so a bare lookup of `constructor`
    // or `valueOf` would find a function on the prototype and run it as a tool.
    const name = request.params.name;
    const handler = Object.hasOwn(browxai.wireHandlers, name)
      ? browxai.wireHandlers[name]
      : Object.hasOwn(browxai.handlers, name)
        ? browxai.handlers[name]
        : undefined;
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `browxai: unknown tool "${name}"` }],
      };
    }
    return await handler(request.params.arguments ?? {});
  });
  return mcp;
}
