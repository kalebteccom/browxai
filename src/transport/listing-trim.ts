// Stdio transport that slims the `tools/list` payload on the wire.
//
// The SDK's `McpServer` stamps every listed tool with
// `inputSchema.$schema = "http://json-schema.org/draft-07/schema#"` and
// `execution: { taskSupport: "forbidden" }`. Both are spec defaults when absent
// ("forbidden" for `execution.taskSupport`, JSON Schema 2020-12 for a missing
// `$schema`), and together they cost about 19k chars across the tool surface.
// This transport drops them from `tools/list` responses and changes nothing else.
//
// A schema keeps its `$schema` when it uses a keyword whose meaning differs
// between draft-07 and 2020-12 (`definitions`, `$ref`, tuple `items`,
// `additionalItems`, `dependencies`): without the marker a client would read it
// under a dialect it was not written for.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const DIALECT_SENSITIVE_KEYS = ["definitions", "$ref", "additionalItems", "dependencies"];

/** True when the schema (at any depth) uses a keyword that reads differently in 2020-12. */
function isDialectSensitive(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(isDialectSensitive);
  if (node === null || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if (DIALECT_SENSITIVE_KEYS.some((k) => k in obj)) return true;
  if (Array.isArray(obj.items)) return true;
  return Object.values(obj).some(isDialectSensitive);
}

function trimTool(tool: unknown): unknown {
  if (tool === null || typeof tool !== "object") return tool;
  const { execution, inputSchema, ...rest } = tool as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  const forbidden =
    execution !== null &&
    typeof execution === "object" &&
    Object.keys(execution).length === 1 &&
    (execution as { taskSupport?: unknown }).taskSupport === "forbidden";
  if (execution !== undefined && !forbidden) out.execution = execution;
  if (inputSchema !== undefined) {
    if (
      inputSchema !== null &&
      typeof inputSchema === "object" &&
      (inputSchema as { $schema?: unknown }).$schema === DRAFT_07 &&
      !isDialectSensitive(inputSchema)
    ) {
      const { $schema: _dropped, ...schemaRest } = inputSchema as Record<string, unknown>;
      out.inputSchema = schemaRest;
    } else {
      out.inputSchema = inputSchema;
    }
  }
  return out;
}

/** Returns `message` with the redundant per-tool keys removed when it is a `tools/list` result. */
export function trimToolListing(message: JSONRPCMessage): JSONRPCMessage {
  if (!("result" in message)) return message;
  const result = message.result as { tools?: unknown } | undefined;
  if (result === undefined || result === null || !Array.isArray(result.tools)) return message;
  return { ...message, result: { ...result, tools: result.tools.map(trimTool) } };
}

export class ListingTrimStdioTransport extends StdioServerTransport {
  override send(message: JSONRPCMessage): Promise<void> {
    return super.send(trimToolListing(message));
  }
}
