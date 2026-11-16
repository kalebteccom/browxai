import { describe, it, expect } from "vitest";
// The core-tool rows come from the tools-layer bootstrap the server imports.
import "../tools/tool-metadata.js";
import { resolveCapabilities } from "./capabilities.js";
import { createToolListing, parseToolList } from "./tool-list.js";

const caps = (list?: string) => resolveCapabilities({ BROWX_CAPABILITIES: list });

describe("parseToolList", () => {
  it("returns undefined for unset and blank, and the mode otherwise", () => {
    expect(parseToolList(undefined)).toBeUndefined();
    expect(parseToolList("  ")).toBeUndefined();
    expect(parseToolList("all")).toBe("all");
    expect(parseToolList("ENABLED")).toBe("enabled");
  });

  it("throws on anything else, naming the source", () => {
    expect(() => parseToolList("yes")).toThrow(/BROWX_TOOL_LIST: unknown value "yes"/);
    expect(() => parseToolList("yes", "user.toolList")).toThrow(/^user\.toolList: unknown value/);
  });
});

describe("createToolListing", () => {
  it("lists everything in all mode, whatever the capabilities", () => {
    const listing = createToolListing("all", caps());
    expect(listing.isListed("eval_js")).toBe(true);
    expect(listing.isListed("no_such_tool")).toBe(true);
  });

  it("follows the call-time gate for core tools in enabled mode", () => {
    const off = createToolListing("enabled", caps());
    expect(off.isListed("snapshot")).toBe(true);
    expect(off.isListed("open_session")).toBe(true);
    expect(off.isListed("eval_js")).toBe(false);
    expect(off.isListed("network_body")).toBe(false);
    const on = createToolListing("enabled", caps("read,navigation,action,human,eval"));
    expect(on.isListed("eval_js")).toBe(true);
    expect(on.isListed("network_body")).toBe(false);
  });

  it("applies the declared capability of a plugin tool", () => {
    const listing = createToolListing("enabled", caps());
    listing.notePluginTool("ns_read_thing", "read");
    listing.notePluginTool("ns_eval_thing", "eval");
    listing.notePluginTool("ns_plain_thing", undefined);
    expect(listing.isListed("ns_read_thing")).toBe(true);
    expect(listing.isListed("ns_eval_thing")).toBe(false);
    expect(listing.isListed("ns_plain_thing")).toBe(true);
    const withEval = createToolListing("enabled", caps("read,navigation,action,human,eval"));
    withEval.notePluginTool("ns_eval_thing", "eval");
    expect(withEval.isListed("ns_eval_thing")).toBe(true);
  });
});
