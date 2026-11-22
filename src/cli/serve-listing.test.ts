import { describe, expect, it } from "vitest";
import type { ToolRegistration } from "../tools/host.js";
import { CAPABILITY_META_KEY, listedTool, PLUGIN_TOOL_SUMMARY, toolRow } from "./serve-listing.js";

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
  it("is a tools/list entry with a real description, the capability in _meta and an open schema", () => {
    const entry = listedTool("snapshot", reg("Read the page as a compact tree.", "read"));
    expect(entry.name).toBe("snapshot");
    expect(entry.description).toBe("Read the page as a compact tree.");
    expect(entry.description).not.toMatch(/^browxai\//);
    expect(entry._meta[CAPABILITY_META_KEY]).toBe("read");
    expect(entry.inputSchema).toEqual({ type: "object", additionalProperties: true });
  });

  it("lists a plugin tool with the plugin label", () => {
    expect(listedTool("example.echo", undefined)._meta[CAPABILITY_META_KEY]).toBe("plugin");
  });
});
