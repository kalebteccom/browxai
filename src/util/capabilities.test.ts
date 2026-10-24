import { describe, it, expect } from "vitest";
// RFC 0004 P2: TOOL_CAPABILITY is now DERIVED from the colocated `host.register`
// metadata (collected by the tools-layer bootstrap). A standalone caller of
// `resolveCapabilities` / `isToolEnabled` — like this unit test — loads the
// bootstrap so the lazy collector is installed and the derived rows are present.
import "../tools/tool-metadata.js";
import {
  capabilitiesWith,
  DEFAULT_CAPABILITIES,
  isToolEnabled,
  resolveCapabilities,
  resolveConfirmHooks,
} from "./capabilities.js";

describe("resolveCapabilities (BROWX_CAPABILITIES)", () => {
  it("returns the default set when unset", () => {
    const c = resolveCapabilities({});
    expect([...c.enabled].sort()).toEqual([...DEFAULT_CAPABILITIES].sort());
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
  it.each<[string, NodeJS.ProcessEnv, Array<[string, boolean]>]>([
    [
      "treats unknown tools as enabled (human-coordination default)",
      { BROWX_CAPABILITIES: "read" },
      [["unknown_tool", true]],
    ],
    ["network_body is off under the default capability set (gate)", {}, [["network_body", false]]],
    [
      "network_body is on once network-body is granted",
      { BROWX_CAPABILITIES: "read,network-body" },
      [["network_body", true]],
    ],
    [
      "credentials is off under the default set: get_totp + get_credential gate on it",
      {},
      [
        ["get_totp", false],
        ["get_credential", false],
      ],
    ],
    [
      "get_totp + get_credential are on once credentials is granted",
      { BROWX_CAPABILITIES: "read,credentials" },
      [
        ["get_totp", true],
        ["get_credential", true],
      ],
    ],
    [
      "ws_send / ws_intercept / ws_unintercept gate on `action` (default-on)",
      {},
      [
        ["ws_send", true],
        ["ws_intercept", true],
        ["ws_unintercept", true],
      ],
    ],
    [
      "read-only server: WS interactive primitives are off, `ws_read` stays",
      { BROWX_CAPABILITIES: "read" },
      [
        ["ws_send", false],
        ["ws_intercept", false],
        ["ws_unintercept", false],
        ["ws_read", true],
      ],
    ],
  ])("%s", (_label, env, checks) => {
    const c = resolveCapabilities(env);
    for (const [tool, enabled] of checks) expect(isToolEnabled(tool, c), tool).toBe(enabled);
  });
});

describe("resolveConfirmHooks (BROWX_CONFIRM_REQUIRED)", () => {
  it("defaults to navigate_off_allowlist + byob_action", () => {
    const h = resolveConfirmHooks({});
    expect(h.has("navigate_off_allowlist")).toBe(true);
    expect(h.has("byob_action")).toBe(true);
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
});
