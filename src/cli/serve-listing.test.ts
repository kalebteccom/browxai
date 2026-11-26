import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolRegistration } from "../tools/host.js";
import {
  CAPABILITY_META_KEY,
  inputSchemaOf,
  listedTool,
  PLUGIN_TOOL_SUMMARY,
  toolRow,
} from "./serve-listing.js";

const reg = (
  description: string,
  capability?: ToolRegistration["capability"],
): ToolRegistration => ({
  description,
  ...(capability === undefined ? {} : { capability }),
});

describe("toolRow", () => {
  it("takes the first sentence of the description and the registered capability", () => {
    expect(
      toolRow("click", reg("Click an element. It scrolls into view first.", "action")),
    ).toEqual({
      name: "click",
      capability: "action",
      description: "Click an element.",
    });
  });

  it("labels a tool that declares no capability none", () => {
    expect(toolRow("list_sessions", reg("List the open sessions.")).capability).toBe("none");
  });

  it("labels a tool with no registration record a plugin tool", () => {
    expect(toolRow("example.echo", undefined)).toEqual({
      name: "example.echo",
      capability: "plugin",
      description: PLUGIN_TOOL_SUMMARY,
    });
  });

  it("flattens a multi-line description onto one line", () => {
    const row = toolRow("t", reg("Do a thing\n  across two lines. Then more.", "read"));
    expect(row.description).toBe("Do a thing across two lines.");
  });
});

describe("listedTool", () => {
  const snapshot: ToolRegistration = {
    description: "Read the page as a compact tree. Refs are stable until the page changes.",
    capability: "read",
    inputSchema: {
      session: z.string().optional().describe("The session id."),
      maxNodes: z.number().int().describe("How many nodes to return."),
    },
  };

  it("is a tools/list entry with the full description and the capability in _meta", () => {
    const entry = listedTool("snapshot", snapshot);
    expect(entry.name).toBe("snapshot");
    expect(entry.description).toBe(snapshot.description);
    expect(entry._meta[CAPABILITY_META_KEY]).toBe("read");
  });

  it("lists the tool's real input schema, with no dialect marker", () => {
    const schema = listedTool("snapshot", snapshot).inputSchema as {
      type: string;
      properties: Record<string, { type: string; description: string }>;
      required: string[];
      $schema?: string;
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual(["maxNodes", "session"]);
    expect(schema.properties.session?.description).toBe("The session id.");
    expect(schema.properties.maxNodes?.type).toBe("integer");
    expect(schema.required).toEqual(["maxNodes"]);
    expect(schema.$schema).toBeUndefined();
  });

  it("lists a tool that takes no arguments with an object schema", () => {
    const entry = listedTool("list_sessions", reg("List the open sessions."));
    expect(entry.inputSchema.type).toBe("object");
    expect(inputSchemaOf(reg("List the open sessions."))?.properties).toEqual({});
  });

  it("lists a plugin tool with the fixed line, an open schema and the plugin label", () => {
    const entry = listedTool("example.echo", undefined);
    expect(entry.description).toBe(PLUGIN_TOOL_SUMMARY);
    expect(entry.inputSchema).toEqual({ type: "object", additionalProperties: true });
    expect(entry._meta[CAPABILITY_META_KEY]).toBe("plugin");
  });
});
