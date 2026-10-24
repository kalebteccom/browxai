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
