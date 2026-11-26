import { describe, it, expect } from "vitest";
// RFC 0004 P2: TOOL_CAPABILITY is now DERIVED from the colocated `host.register`
// metadata (collected by the tools-layer bootstrap). A standalone caller of
// `resolveCapabilities` / `isToolEnabled` — like this unit test — loads the
// bootstrap so the lazy collector is installed and the derived rows are present.
import "../tools/tool-metadata.js";
import {
  capabilitiesAssignment,
  capabilitiesWith,
  DEFAULT_CAPABILITIES,
  isToolEnabled,
  resolveCapabilities,
  resolveConfirmHooks,
  confirmHookWarnings,
} from "./capabilities.js";

describe("resolveCapabilities (BROWX_CAPABILITIES)", () => {
  it("returns the default set when unset", () => {
    const c = resolveCapabilities({});
    expect([...c.enabled].sort()).toEqual([...DEFAULT_CAPABILITIES].sort());
  });

  it("parses an explicit comma-separated list", () => {
    const c = resolveCapabilities({ BROWX_CAPABILITIES: "read,navigation" });
    expect([...c.enabled].sort()).toEqual(["navigation", "read"]);
  });

  it("rejects unknown capabilities loudly", () => {
    expect(() => resolveCapabilities({ BROWX_CAPABILITIES: "read,banana" })).toThrow(/banana/);
  });

  it("tolerates a retired capability — warns, never throws (old configs survive)", () => {
    const c = resolveCapabilities({
      BROWX_CAPABILITIES: "read,navigation,unstable",
    });
    expect([...c.enabled].sort()).toEqual(["navigation", "read"]); // retired one dropped
    expect(c.warnings.some((w) => /unstable/.test(w) && /retired/.test(w))).toBe(true);
  });

  it("default set excludes eval / byob-attach / file-io", () => {
    const c = resolveCapabilities({});
    expect(c.enabled.has("eval")).toBe(false);
    expect(c.enabled.has("byob-attach")).toBe(false);
    expect(c.enabled.has("file-io")).toBe(false);
  });

  it("reports disabled tools when a capability is off", () => {
    const c = resolveCapabilities({ BROWX_CAPABILITIES: "read" });
    const tools = c.disabledTools.map((d) => d.tool);
    expect(tools).toContain("navigate");
    expect(tools).toContain("click");
    expect(tools).toContain("eval_js");
    expect(tools).not.toContain("snapshot");
  });
});

describe("isToolEnabled", () => {
  it("treats unknown tools as enabled (human-coordination default)", () => {
    const c = resolveCapabilities({ BROWX_CAPABILITIES: "read" });
    expect(isToolEnabled("unknown_tool", c)).toBe(true);
  });

  it("network_body is off under the default capability set (gate)", () => {
    const def = resolveCapabilities({});
    expect(isToolEnabled("network_body", def)).toBe(false);
    const on = resolveCapabilities({
      BROWX_CAPABILITIES: "read,network-body",
    });
    expect(isToolEnabled("network_body", on)).toBe(true);
  });

  it("credentials is off under the default capability set; get_totp + get_credential gate on it", () => {
    const def = resolveCapabilities({});
    expect(isToolEnabled("get_totp", def)).toBe(false);
    expect(isToolEnabled("get_credential", def)).toBe(false);
    const on = resolveCapabilities({
      BROWX_CAPABILITIES: "read,credentials",
    });
    expect(isToolEnabled("get_totp", on)).toBe(true);
    expect(isToolEnabled("get_credential", on)).toBe(true);
  });

  it("ws_send / ws_intercept / ws_unintercept gate on `action` (default-on)", () => {
    const def = resolveCapabilities({});
    expect(isToolEnabled("ws_send", def)).toBe(true);
    expect(isToolEnabled("ws_intercept", def)).toBe(true);
    expect(isToolEnabled("ws_unintercept", def)).toBe(true);
    // read-only server: WS interactive primitives are off, but `ws_read` stays.
    const readOnly = resolveCapabilities({ BROWX_CAPABILITIES: "read" });
    expect(isToolEnabled("ws_send", readOnly)).toBe(false);
    expect(isToolEnabled("ws_intercept", readOnly)).toBe(false);
    expect(isToolEnabled("ws_unintercept", readOnly)).toBe(false);
    expect(isToolEnabled("ws_read", readOnly)).toBe(true);
  });
});

describe("resolveConfirmHooks (BROWX_CONFIRM_REQUIRED)", () => {
  it("defaults to navigate_off_allowlist + byob_action + native_device_app", () => {
    const h = resolveConfirmHooks({});
    expect(h.has("navigate_off_allowlist")).toBe(true);
    expect(h.has("byob_action")).toBe(true);
    expect(h.has("native_device_app")).toBe(true);
    expect(h.has("file_download")).toBe(false);
  });

  it("parses an explicit list", () => {
    const h = resolveConfirmHooks({ BROWX_CONFIRM_REQUIRED: "file_download" });
    expect(h.has("file_download")).toBe(true);
    expect(h.has("byob_action")).toBe(false);
  });

  it("rejects unknown hooks", () => {
    expect(() => resolveConfirmHooks({ BROWX_CONFIRM_REQUIRED: "fly_to_moon" })).toThrow(
      /fly_to_moon/,
    );
  });
});

describe("capabilitiesWith / capabilitiesAssignment", () => {
  it("is the defaults plus the extra capability, comma-joined", () => {
    expect(capabilitiesWith("byob-attach")).toBe(
      [...DEFAULT_CAPABILITIES, "byob-attach"].join(","),
    );
    expect(capabilitiesWith("byob-attach")).toBe("read,navigation,action,human,byob-attach");
  });

  it("does not repeat a capability the defaults already hold", () => {
    expect(capabilitiesWith("human")).toBe("read,navigation,action,human");
    expect(capabilitiesWith("read,eval")).toBe("read,navigation,action,human,eval");
  });

  it("renders the BROWX_CAPABILITIES assignment", () => {
    expect(capabilitiesAssignment("byob-attach")).toBe(
      "BROWX_CAPABILITIES=read,navigation,action,human,byob-attach",
    );
  });
});

describe("confirmHookWarnings (BROWX_CONFIRM_REQUIRED overrides)", () => {
  const warningsFor = (value?: string) =>
    confirmHookWarnings(
      resolveConfirmHooks(value === undefined ? {} : { BROWX_CONFIRM_REQUIRED: value }),
    );

  it("says nothing when the variable is unset or empty", () => {
    expect(warningsFor()).toEqual([]);
    expect(warningsFor("  ")).toEqual([]);
  });

  it("says nothing for the full default list, in either order", () => {
    expect(warningsFor("navigate_off_allowlist,byob_action")).toEqual([]);
    // Leaving native_device_app out makes a phone stricter (refuse, never ask),
    // so it earns no warning.
    expect(warningsFor("navigate_off_allowlist,byob_action,native_device_app")).toEqual([]);
    expect(warningsFor("byob_action, navigate_off_allowlist")).toEqual([]);
  });

  it("warns that byob_action is gone when only navigate_off_allowlist is listed", () => {
    const w = warningsFor("navigate_off_allowlist");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"byob_action" is not in the list');
    expect(w[0]).toContain("attached sessions run without a hold");
    expect(w[0]).toContain("BROWX_CONFIRM_REQUIRED=navigate_off_allowlist,byob_action");
  });

  it("warns that navigate_off_allowlist is gone when only byob_action is listed", () => {
    const w = warningsFor("byob_action");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"navigate_off_allowlist" is not in the list');
    expect(w[0]).toContain("proceeds with a log line and no prompt");
  });

  it("warns for both reserved names and both missing defaults on the reserved pair", () => {
    const w = warningsFor("file_download,file_upload");
    expect(w).toHaveLength(4);
    expect(w[0]).toContain('"file_download" is accepted and reserved');
    expect(w[1]).toContain('"file_upload" is accepted and reserved');
    expect(w[2]).toContain('"navigate_off_allowlist" is not in the list');
    expect(w[3]).toContain('"byob_action" is not in the list');
    expect(w[3]).toContain("BROWX_CONFIRM_REQUIRED=file_download,file_upload,byob_action");
  });

  it("warns only about the reserved name when the defaults are kept", () => {
    const w = warningsFor("navigate_off_allowlist,byob_action,file_upload");
    expect(w).toEqual([
      'BROWX_CONFIRM_REQUIRED: "file_upload" is accepted and reserved. No tool consults it yet, so it holds nothing.',
    ]);
  });

  it("leaves the resolved set as written: the list still replaces the defaults", () => {
    const hooks = resolveConfirmHooks({ BROWX_CONFIRM_REQUIRED: "file_download" });
    expect([...hooks]).toEqual(["file_download"]);
  });
});
