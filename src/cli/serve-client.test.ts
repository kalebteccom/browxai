// The daemon's per-connection MCP server, driven by a real MCP client over an in-memory
// pair. The listing carries each tool's full description and input schema, and that
// schema is for the client to read: an argument it does not name still reaches the handler.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolRegistration, ToolResponse } from "../tools/host.js";
import { createClientServer, type ClientHandlers } from "./serve-client.js";
import { CAPABILITY_META_KEY } from "./serve-listing.js";

const DESCRIPTION = "Echo the arguments back. Used to see what reached the handler.";

async function connected(listed: (name: string) => boolean = () => true) {
  const seen: unknown[] = [];
  const echo = (args: unknown): Promise<ToolResponse> => {
    seen.push(args);
    return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(args) }] });
  };
  const registrations = new Map<string, ToolRegistration>([
    [
      "probe_echo",
      {
        description: DESCRIPTION,
        capability: "read",
        inputSchema: { named: z.string().describe("The one argument the schema names.") },
      },
    ],
  ]);
  const handlers = {
    handlers: { probe_echo: echo, "example.echo": echo },
    wireHandlers: { probe_echo: echo },
    isToolListed: listed,
    registrations,
  } as unknown as ClientHandlers;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createClientServer(handlers).connect(serverSide);
  const client = new Client({ name: "serve-client-test", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, seen };
}

describe("the daemon's tools/list", () => {
  it("lists a tool with its full description, its input schema and its capability", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const probe = tools.find((t) => t.name === "probe_echo");
    expect(probe?.description).toBe(DESCRIPTION);
    expect(probe?.inputSchema.type).toBe("object");
    expect(probe?.inputSchema.properties).toHaveProperty("named");
    expect(probe?.inputSchema.required).toEqual(["named"]);
    expect(probe?._meta?.[CAPABILITY_META_KEY]).toBe("read");
    await client.close();
  });

  it("lists a plugin tool with a fixed line and an open schema", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const plugin = tools.find((t) => t.name === "example.echo");
    expect(plugin?.description).toBe("A plugin tool.");
    expect(plugin?.inputSchema).toEqual({ type: "object", additionalProperties: true });
    expect(plugin?._meta?.[CAPABILITY_META_KEY]).toBe("plugin");
    await client.close();
  });

  it("leaves out a tool the listing filter drops, and still runs it by name", async () => {
    const { client, seen } = await connected((name) => name !== "probe_echo");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["example.echo"]);
    await client.callTool({ name: "probe_echo", arguments: { named: "x" } });
    expect(seen).toEqual([{ named: "x" }]);
    await client.close();
  });
});

describe("the daemon's tools/call", () => {
  it("passes an argument the listed schema does not name through to the handler", async () => {
    const { client, seen } = await connected();
    await client.listTools();
    const args = { named: "x", extra: { nested: [1, 2] }, session: "s1" };
    const res = await client.callTool({ name: "probe_echo", arguments: args });
    expect(seen).toEqual([args]);
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toEqual(args);
    await client.close();
  });

  it("passes arguments that do not satisfy the listed schema, for the handler to judge", async () => {
    const { client, seen } = await connected();
    await client.listTools();
    await client.callTool({ name: "probe_echo", arguments: { named: 42 } });
    expect(seen).toEqual([{ named: 42 }]);
    await client.close();
  });

  it("answers an unknown tool, and a name found only on the prototype, with an error result", async () => {
    const { client, seen } = await connected();
    for (const name of ["no_such_tool", "constructor"]) {
      const res = await client.callTool({ name, arguments: {} });
      expect(res.isError, name).toBe(true);
    }
    expect(seen).toEqual([]);
    await client.close();
  });
});
