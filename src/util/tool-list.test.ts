import { describe, it, expect } from "vitest";
// The core-tool rows come from the tools-layer bootstrap the server imports.
import "../tools/tool-metadata.js";
import { resolveCapabilities } from "./capabilities.js";
import { createToolListing, parseToolList } from "./tool-list.js";
import { CORE_TOOLS, TOOL_CATALOG_TOOL } from "./tool-profile.js";

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

describe("createToolListing with the core profile", () => {
  it("lists the core tools, the discovery tool and nothing else of the core surface", () => {
    const listing = createToolListing("all", caps(), "core");
    expect(listing.profile).toBe("core");
    for (const name of CORE_TOOLS) expect(listing.isListed(name)).toBe(true);
    expect(listing.isListed(TOOL_CATALOG_TOOL)).toBe(true);
    expect(listing.isListed("open_session")).toBe(false);
    expect(listing.isListed("eval_js")).toBe(false);
    expect(listing.isListed("get_config")).toBe(false);
  });

  it("keeps plugin tools listed, whatever the profile", () => {
    const listing = createToolListing("all", caps(), "core");
    listing.notePluginTool("ns_thing", "eval");
    expect(listing.isListed("ns_thing")).toBe(true);
  });

  it("applies the capability filter first: a plugin tool with its capability off stays out under enabled", () => {
    const listing = createToolListing("enabled", caps(), "core");
    listing.notePluginTool("ns_eval_thing", "eval");
    listing.notePluginTool("ns_plain_thing", undefined);
    expect(listing.isListed("ns_eval_thing")).toBe(false);
    expect(listing.isListed("ns_plain_thing")).toBe(true);
  });

  it("with toolList all, keeps a core tool whose capability is off", () => {
    // With only `read` on, `click` (an `action` tool) has its capability off.
    const readOnly = caps("read");
    const all = createToolListing("all", readOnly, "core");
    const enabled = createToolListing("enabled", readOnly, "core");
    expect(all.isListed("click")).toBe(true);
    expect(enabled.isListed("click")).toBe(false);
    expect(enabled.isListed("snapshot")).toBe(true);
  });

  it("changes nothing under the full profile", () => {
    const full = createToolListing("all", caps(), "full");
    const unset = createToolListing("all", caps());
    for (const name of ["eval_js", "open_session", "click", "no_such_tool"]) {
      expect(full.isListed(name)).toBe(true);
      expect(unset.isListed(name)).toBe(true);
    }
  });
});
