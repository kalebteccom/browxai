import { describe, it, expect } from "vitest";
import {
  ALL_CAPABILITIES, DEFAULT_CAPABILITIES, isToolEnabled, resolveCapabilities, resolveConfirmHooks,
} from "./capabilities.js";

describe("resolveCapabilities (BROWX_CAPABILITIES)", () => {
  it("returns the default set when unset", () => {
    const c = resolveCapabilities({} as NodeJS.ProcessEnv);
    expect([...c.enabled].sort()).toEqual([...DEFAULT_CAPABILITIES].sort());
  });

  it("parses an explicit comma-separated list", () => {
    const c = resolveCapabilities({ BROWX_CAPABILITIES: "read,navigation" } as NodeJS.ProcessEnv);
    expect([...c.enabled].sort()).toEqual(["navigation", "read"]);
  });

  it("rejects unknown capabilities loudly", () => {
    expect(() => resolveCapabilities({ BROWX_CAPABILITIES: "read,banana" } as NodeJS.ProcessEnv)).toThrow(/banana/);
  });

  it("tolerates a retired capability — warns, never throws (old configs survive)", () => {
    const c = resolveCapabilities({ BROWX_CAPABILITIES: "read,navigation,unstable" } as NodeJS.ProcessEnv);
    expect([...c.enabled].sort()).toEqual(["navigation", "read"]); // retired one dropped
    expect(c.warnings.some((w) => /unstable/.test(w) && /retired/.test(w))).toBe(true);
  });

  it("a genuine typo still throws even alongside a retired capability", () => {
    expect(() => resolveCapabilities({ BROWX_CAPABILITIES: "read,unstable,banana" } as NodeJS.ProcessEnv))
      .toThrow(/banana/);
  });

  it("emits no warnings for an all-valid capability set", () => {
    expect(resolveCapabilities({ BROWX_CAPABILITIES: "read,navigation" } as NodeJS.ProcessEnv).warnings).toEqual([]);
  });

  it("default set excludes eval / byob-attach / file-io", () => {
    const c = resolveCapabilities({} as NodeJS.ProcessEnv);
    expect(c.enabled.has("eval")).toBe(false);
    expect(c.enabled.has("byob-attach")).toBe(false);
    expect(c.enabled.has("file-io")).toBe(false);
  });

  it("reports disabled tools when a capability is off", () => {
    const c = resolveCapabilities({ BROWX_CAPABILITIES: "read" } as NodeJS.ProcessEnv);
    const tools = c.disabledTools.map((d) => d.tool);
    expect(tools).toContain("navigate");
    expect(tools).toContain("click");
    expect(tools).toContain("eval_js");
    expect(tools).not.toContain("snapshot");
  });
});

describe("isToolEnabled", () => {
  it("returns false for tools whose capability isn't enabled", () => {
    const c = resolveCapabilities({ BROWX_CAPABILITIES: "read" } as NodeJS.ProcessEnv);
    expect(isToolEnabled("navigate", c)).toBe(false);
    expect(isToolEnabled("snapshot", c)).toBe(true);
  });

  it("treats unknown tools as enabled (human-coordination default)", () => {
    const c = resolveCapabilities({ BROWX_CAPABILITIES: "read" } as NodeJS.ProcessEnv);
    expect(isToolEnabled("unknown_tool", c)).toBe(true);
  });

  it("network_body is off under the default capability set (gate)", () => {
    const def = resolveCapabilities({} as NodeJS.ProcessEnv);
    expect(isToolEnabled("network_body", def)).toBe(false);
    const on = resolveCapabilities({ BROWX_CAPABILITIES: "read,network-body" } as NodeJS.ProcessEnv);
    expect(isToolEnabled("network_body", on)).toBe(true);
  });

  it("network-body is a valid capability but not in the default set", () => {
    expect(ALL_CAPABILITIES).toContain("network-body");
    expect(DEFAULT_CAPABILITIES).not.toContain("network-body");
  });

  it("credentials is off under the default capability set; get_totp + get_credential gate on it", () => {
    const def = resolveCapabilities({} as NodeJS.ProcessEnv);
    expect(isToolEnabled("get_totp", def)).toBe(false);
    expect(isToolEnabled("get_credential", def)).toBe(false);
    const on = resolveCapabilities({
      BROWX_CAPABILITIES: "read,credentials",
    } as NodeJS.ProcessEnv);
    expect(isToolEnabled("get_totp", on)).toBe(true);
    expect(isToolEnabled("get_credential", on)).toBe(true);
  });

  it("credentials is a valid capability but not in the default set", () => {
    expect(ALL_CAPABILITIES).toContain("credentials");
    expect(DEFAULT_CAPABILITIES).not.toContain("credentials");
  });
});

describe("resolveConfirmHooks (BROWX_CONFIRM_REQUIRED)", () => {
  it("defaults to navigate_off_allowlist + byob_action", () => {
    const h = resolveConfirmHooks({} as NodeJS.ProcessEnv);
    expect(h.has("navigate_off_allowlist")).toBe(true);
    expect(h.has("byob_action")).toBe(true);
    expect(h.has("file_download")).toBe(false);
  });

  it("parses an explicit list", () => {
    const h = resolveConfirmHooks({ BROWX_CONFIRM_REQUIRED: "file_download" } as NodeJS.ProcessEnv);
    expect(h.has("file_download")).toBe(true);
    expect(h.has("byob_action")).toBe(false);
  });

  it("rejects unknown hooks", () => {
    expect(() => resolveConfirmHooks({ BROWX_CONFIRM_REQUIRED: "fly_to_moon" } as NodeJS.ProcessEnv)).toThrow(/fly_to_moon/);
  });
});

describe("ALL_CAPABILITIES sanity", () => {
  it("includes every category named in DEFAULT_CAPABILITIES", () => {
    for (const c of DEFAULT_CAPABILITIES) expect(ALL_CAPABILITIES).toContain(c);
  });
});
