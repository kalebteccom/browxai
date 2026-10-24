import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ListingTrimTransport, trimToolListing } from "./listing-trim.js";
import { TIMEOUT_ARG } from "../tools/schemas.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

const listing = (tools: unknown[], id = 2): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  result: { tools },
});

const toolsOf = (m: JSONRPCMessage) =>
  (m as unknown as { result: { tools: Array<Record<string, unknown>> } }).result.tools;

const listRequest = (id: number): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "tools/list" });

class FakeTransport implements Transport {
  sent: Array<{ message: JSONRPCMessage; options: TransportSendOptions | undefined }> = [];
  onmessage?: Transport["onmessage"];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  start(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.sent.push({ message, options });
    return Promise.resolve();
  }
}

function wrapped() {
  const inner = new FakeTransport();
  const transport = new ListingTrimTransport(inner);
  const received: JSONRPCMessage[] = [];
  transport.onmessage = (m) => received.push(m);
  return { inner, transport, received };
}

const sampleTool = {
  name: "click",
  description: "d",
  inputSchema: { $schema: DRAFT_07, type: "object", properties: { a: { type: "string" } } },
  execution: { taskSupport: "forbidden" },
  annotations: { readOnlyHint: false },
};

describe("trimToolListing", () => {
  it("drops $schema and the default execution key, keeps everything else", () => {
    const out = trimToolListing(listing([sampleTool]));
    expect(toolsOf(out)[0]).toEqual({
      name: "click",
      description: "d",
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
      annotations: { readOnlyHint: false },
    });
  });

  it("keeps a non-default execution value", () => {
    const out = trimToolListing(
      listing([
        { name: "t", inputSchema: { type: "object" }, execution: { taskSupport: "optional" } },
      ]),
    );
    expect(toolsOf(out)[0]?.execution).toEqual({ taskSupport: "optional" });
  });

  it("keeps an execution object that carries extra keys", () => {
    const execution = { taskSupport: "forbidden", extra: true };
    const out = trimToolListing(
      listing([{ name: "t", inputSchema: { type: "object" }, execution }]),
    );
    expect(toolsOf(out)[0]?.execution).toEqual(execution);
  });

  it("keeps $schema on a schema that uses definitions and $ref", () => {
    const schema = {
      $schema: DRAFT_07,
      type: "object",
      properties: { p: { $ref: "#/definitions/node" } },
      definitions: { node: { type: "string" } },
    };
    const out = trimToolListing(listing([{ name: "verify_predicate", inputSchema: schema }]));
    expect(toolsOf(out)[0]?.inputSchema).toEqual(schema);
  });

  it("keeps $schema when a nested property uses $ref", () => {
    const schema = {
      $schema: DRAFT_07,
      type: "object",
      properties: { outer: { type: "object", properties: { inner: { $ref: "#/x" } } } },
    };
    const out = trimToolListing(listing([{ name: "t", inputSchema: schema }]));
    expect(toolsOf(out)[0]?.inputSchema).toEqual(schema);
  });

  it("keeps $schema on a schema with tuple items", () => {
    const schema = {
      $schema: DRAFT_07,
      type: "object",
      properties: { t: { type: "array", items: [{ type: "number" }, { type: "number" }] } },
    };
    const out = trimToolListing(listing([{ name: "t", inputSchema: schema }]));
    expect(toolsOf(out)[0]?.inputSchema).toEqual(schema);
  });

  it("keeps a $schema that is not draft-07", () => {
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };
    const out = trimToolListing(listing([{ name: "t", inputSchema: schema }]));
    expect(toolsOf(out)[0]?.inputSchema).toEqual(schema);
  });

  it("passes non-object tool entries through", () => {
    const out = trimToolListing(listing(["odd", null, 7]));
    expect(toolsOf(out)).toEqual(["odd", null, 7]);
  });

  it("returns a null or missing result untouched", () => {
    const nullResult = { jsonrpc: "2.0", id: 5, result: null } as unknown as JSONRPCMessage;
    const noTools = { jsonrpc: "2.0", id: 6, result: {} } as JSONRPCMessage;
    expect(trimToolListing(nullResult)).toBe(nullResult);
    expect(trimToolListing(noTools)).toBe(noTools);
  });

  it("returns requests and call results untouched", () => {
    const call = { jsonrpc: "2.0", id: 3, result: { content: [] } } as JSONRPCMessage;
    const request = { jsonrpc: "2.0", id: 4, method: "ping" } as JSONRPCMessage;
    expect(trimToolListing(call)).toBe(call);
    expect(trimToolListing(request)).toBe(request);
  });
});

describe("ListingTrimTransport", () => {
  it("trims the response to a tools/list request and forwards send options", async () => {
    const { inner, transport, received } = wrapped();
    inner.onmessage?.(listRequest(2));
    expect(received).toHaveLength(1);
    const options: TransportSendOptions = { relatedRequestId: 2 };
    await transport.send(listing([sampleTool], 2), options);
    expect(inner.sent).toHaveLength(1);
    expect(toolsOf(inner.sent[0]!.message)[0]).not.toHaveProperty("execution");
    expect(inner.sent[0]!.options).toBe(options);
  });

  it("leaves a tools-shaped response alone when its id was not a tools/list request", async () => {
    const { inner, transport } = wrapped();
    inner.onmessage?.({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } });
    const message = listing([sampleTool], 9);
    await transport.send(message);
    expect(inner.sent[0]!.message).toBe(message);
  });

  it("trims once per request id", async () => {
    const { inner, transport } = wrapped();
    inner.onmessage?.(listRequest(2));
    await transport.send(listing([sampleTool], 2));
    const again = listing([sampleTool], 2);
    await transport.send(again);
    expect(toolsOf(inner.sent[0]!.message)[0]).not.toHaveProperty("execution");
    expect(inner.sent[1]!.message).toBe(again);
  });

  it("forwards notifications and clears the id on an error response", async () => {
    const { inner, transport } = wrapped();
    inner.onmessage?.(listRequest(3));
    const error = { jsonrpc: "2.0", id: 3, error: { code: -1, message: "x" } } as JSONRPCMessage;
    await transport.send(error);
    expect(inner.sent[0]!.message).toBe(error);
    const later = listing([sampleTool], 3);
    await transport.send(later);
    expect(inner.sent[1]!.message).toBe(later);
  });
});

describe("tools/list through a real McpServer", () => {
  async function listVia(wrap: boolean) {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    server.registerTool(
      "echo",
      { description: "echo", inputSchema: { text: z.string() } },
      (args) => ({
        content: [{ type: "text" as const, text: String(args.text) }],
      }),
    );
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.connect(wrap ? new ListingTrimTransport(serverEnd) : serverEnd);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(clientEnd);
    const { tools } = await client.listTools();
    const called = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    await client.close();
    await server.close();
    return { tool: tools[0] as Record<string, unknown>, called };
  }

  it("lists a tool without execution or $schema, and still calls it", async () => {
    const { tool, called } = await listVia(true);
    expect(tool.name).toBe("echo");
    expect(tool).not.toHaveProperty("execution");
    expect(tool.inputSchema).not.toHaveProperty("$schema");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    expect(called.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("control: the unwrapped SDK emits both keys", async () => {
    const { tool } = await listVia(false);
    expect(tool.execution).toEqual({ taskSupport: "forbidden" });
    expect((tool.inputSchema as Record<string, unknown>).$schema).toBe(DRAFT_07);
  });
});

describe("TIMEOUT_ARG.timeoutMs description", () => {
  const description = TIMEOUT_ARG.timeoutMs.description ?? "";
  it("keeps the retry-once guidance", () => {
    expect(description).toMatch(/retry once/i);
  });
  it("keeps the session recovery step", () => {
    expect(description).toMatch(/close_session/);
  });
});
