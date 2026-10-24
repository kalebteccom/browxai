import { describe, it, expect } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { trimToolListing } from "./listing-trim.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

const listing = (tools: unknown[]): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id: 2,
  result: { tools },
});

const toolsOf = (m: JSONRPCMessage) =>
  (m as unknown as { result: { tools: Array<Record<string, unknown>> } }).result.tools;

describe("trimToolListing", () => {
  it("drops $schema and the default execution key, keeps everything else", () => {
    const out = trimToolListing(
      listing([
        {
          name: "click",
          description: "d",
          inputSchema: { $schema: DRAFT_07, type: "object", properties: { a: { type: "string" } } },
          execution: { taskSupport: "forbidden" },
          annotations: { readOnlyHint: false },
        },
      ]),
    );
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

  it("returns other messages untouched", () => {
    const call = { jsonrpc: "2.0", id: 3, result: { content: [] } } as JSONRPCMessage;
    const request = { jsonrpc: "2.0", id: 4, method: "ping" } as JSONRPCMessage;
    expect(trimToolListing(call)).toBe(call);
    expect(trimToolListing(request)).toBe(request);
  });
});
