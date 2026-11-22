import { describe, it, expect } from "vitest";
import { CORE_TOOLS, isCoreTool, parseToolProfile, TOOL_CATALOG_TOOL } from "./tool-profile.js";

describe("parseToolProfile", () => {
  it("returns undefined for unset and blank, and the profile otherwise", () => {
    expect(parseToolProfile(undefined)).toBeUndefined();
    expect(parseToolProfile("  ")).toBeUndefined();
    expect(parseToolProfile("full")).toBe("full");
    expect(parseToolProfile(" CORE ")).toBe("core");
  });

  it("throws on anything else, naming the source and the valid values", () => {
    expect(() => parseToolProfile("lean")).toThrow(
      /BROWX_TOOL_PROFILE: unknown value "lean"\. Valid: full, core/,
    );
    expect(() => parseToolProfile("lean", "user.toolProfile")).toThrow(
      /^user\.toolProfile: unknown value/,
    );
  });
});

describe("CORE_TOOLS", () => {
  it("holds the 24 tools of the core set, each once", () => {
    expect(CORE_TOOLS).toHaveLength(24);
    expect(new Set(CORE_TOOLS).size).toBe(CORE_TOOLS.length);
  });

  it("is frozen, so a caller cannot grow the set at run time", () => {
    expect(Object.isFrozen(CORE_TOOLS)).toBe(true);
  });

  it("leaves out open_session and the discovery tool", () => {
    expect(isCoreTool("open_session")).toBe(false);
    expect(isCoreTool(TOOL_CATALOG_TOOL)).toBe(false);
    expect(isCoreTool("click")).toBe(true);
  });
});
