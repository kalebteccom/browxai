// open_session({har}) bodies need `network-body`, as `start_har` does.

import { describe, it, expect } from "vitest";
import { resolveOpenSessionPolicies } from "./open-session-policies.js";
import type { GateHost, ToolResponse } from "./host.js";

/** A gate that refuses any extra capability not in `enabled`. */
function gate(enabled: string[]): { gateCheck: GateHost["gateCheck"]; asked: string[][] } {
  const asked: string[][] = [];
  const gateCheck = ((_tool: string, extra?: readonly string[]) => {
    asked.push([...(extra ?? [])]);
    const missing = (extra ?? []).find((c) => !enabled.includes(c));
    if (!missing) return null;
    const text = JSON.stringify({ ok: false, requiredCapability: missing });
    return { content: [{ type: "text", text }] } as ToolResponse;
  }) as unknown as GateHost["gateCheck"];
  return { gateCheck, asked };
}

describe("resolveOpenSessionPolicies — HAR bodies", () => {
  it.each(["embed", "attach"] as const)("refuses har.content %s without network-body", (c) => {
    const { gateCheck } = gate(["read", "action"]);
    const r = resolveOpenSessionPolicies(gateCheck, "s", undefined, { harContent: c });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const body = JSON.parse((r.response.content[0] as { text: string }).text);
      expect(body.requiredCapability).toBe("network-body");
    }
  });

  it("allows har.content embed with network-body", () => {
    const { gateCheck } = gate(["network-body"]);
    expect(resolveOpenSessionPolicies(gateCheck, "s", undefined, { harContent: "embed" }).ok).toBe(
      true,
    );
  });

  it("asks nothing for omit or no HAR", () => {
    const { gateCheck, asked } = gate([]);
    expect(resolveOpenSessionPolicies(gateCheck, "s", undefined, { harContent: "omit" }).ok).toBe(
      true,
    );
    expect(resolveOpenSessionPolicies(gateCheck, "s", undefined, {}).ok).toBe(true);
    expect(asked.flat()).not.toContain("network-body");
  });
});

// Seeding a new session changes what its pages see, as `inject_storage_state`
// and `route` do, so a server without `action` refuses those arguments.
describe("resolveOpenSessionPolicies — state seeding", () => {
  const refusal = (r: ReturnType<typeof resolveOpenSessionPolicies>) => {
    expect(r.ok).toBe(false);
    return r.ok ? undefined : JSON.parse((r.response.content[0] as { text: string }).text);
  };

  it.each([
    ["storageState", { storageState: true, hars: false }],
    ["authState", { storageState: false, authState: true, hars: false }],
    ["hars", { storageState: false, hars: true }],
  ] as const)("refuses %s without action", (_name, seeds) => {
    const { gateCheck } = gate(["read", "navigation", "human"]);
    const body = refusal(resolveOpenSessionPolicies(gateCheck, "s", undefined, { seeds }));
    expect(body.requiredCapability).toBe("action");
  });

  it("allows both with action", () => {
    const { gateCheck } = gate(["read", "action"]);
    const seeds = { storageState: true, authState: true, hars: true };
    expect(resolveOpenSessionPolicies(gateCheck, "s", undefined, { seeds }).ok).toBe(true);
  });

  it("asks nothing when the call seeds nothing", () => {
    const { gateCheck, asked } = gate(["read"]);
    const seeds = { storageState: false, authState: false, hars: false };
    expect(resolveOpenSessionPolicies(gateCheck, "s", undefined, { seeds }).ok).toBe(true);
    expect(asked.flat()).not.toContain("action");
  });
});

// A HAR or a video recorded for the session's lifetime is a file in the
// workspace, so either needs `file-io`.
describe("resolveOpenSessionPolicies — recordings", () => {
  const body = (r: ReturnType<typeof resolveOpenSessionPolicies>) =>
    r.ok ? undefined : JSON.parse((r.response.content[0] as { text: string }).text);

  it.each([
    ["har", { har: true, video: false }],
    ["recordVideo", { har: false, video: true }],
  ] as const)("refuses %s without file-io", (_name, records) => {
    const { gateCheck } = gate(["read", "navigation", "action", "human"]);
    const r = resolveOpenSessionPolicies(gateCheck, "s", undefined, { records });
    expect(r.ok).toBe(false);
    expect(body(r).requiredCapability).toBe("file-io");
  });

  it("allows both with file-io", () => {
    const { gateCheck } = gate(["read", "action", "file-io"]);
    const records = { har: true, video: true };
    expect(resolveOpenSessionPolicies(gateCheck, "s", undefined, { records }).ok).toBe(true);
  });

  it("names network-body first for a HAR with bodies on a server with neither", () => {
    const { gateCheck } = gate(["read", "action"]);
    const r = resolveOpenSessionPolicies(gateCheck, "s", undefined, {
      harContent: "embed",
      records: { har: true, video: false },
    });
    expect(body(r).requiredCapability).toBe("network-body");
  });

  it("asks nothing when the call records nothing", () => {
    const { gateCheck, asked } = gate(["read"]);
    const records = { har: false, video: false };
    expect(resolveOpenSessionPolicies(gateCheck, "s", undefined, { records }).ok).toBe(true);
    expect(asked.flat()).not.toContain("file-io");
  });
});
