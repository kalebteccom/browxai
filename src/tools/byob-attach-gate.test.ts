// The `byob-attach` gate the session factory runs before any attached session.
// Browser-free: the gate is a pure check on the start-time capability set, and
// the keystone (attached-pool) proves it against a real Chrome.

import { describe, it, expect } from "vitest";
import {
  ByobAttachRefused,
  byobAttachRefusal,
  refuseAttachWithoutCapability,
} from "./byob-attach-gate.js";
import type { Capability, CapabilityConfig } from "../util/capabilities.js";
import type { ToolResponse } from "./host.js";

const caps = (...on: string[]) => ({ enabled: new Set(on) }) as unknown as CapabilityConfig;
const DEFAULTS = ["read", "navigation", "action", "human"];

const refuse = (tool: string, extra?: readonly Capability[], reason?: string): ToolResponse => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ ok: false, tool, requiredCapability: extra?.[0], reason }),
    },
  ],
});
const body = (r: ToolResponse | null) =>
  JSON.parse((r!.content[0] as { text: string }).text) as Record<string, unknown>;

describe("refuseAttachWithoutCapability", () => {
  it("refuses an attached session on the default capability set", () => {
    expect(() => refuseAttachWithoutCapability(caps(...DEFAULTS), "s1", "chromium")).toThrow(
      ByobAttachRefused,
    );
  });

  it("refuses on every attach engine, android and electron included", () => {
    for (const engine of ["chromium", "electron", "android"]) {
      expect(() => refuseAttachWithoutCapability(caps(...DEFAULTS), "s1", engine)).toThrow(
        /capability-required/,
      );
    }
  });

  it("names the capability, the session and the full BROWX_CAPABILITIES fix", () => {
    let message = "";
    try {
      refuseAttachWithoutCapability(caps(...DEFAULTS), "agent-a", "chromium");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^capability-required: session "agent-a"/);
    expect(message).toContain("`byob-attach`");
    expect(message).toContain("BROWX_CAPABILITIES=read,navigation,action,human,byob-attach");
    expect(message).toMatch(/restart the server/);
  });

  it("allows the attach when byob-attach is in the active set", () => {
    expect(() =>
      refuseAttachWithoutCapability(caps(...DEFAULTS, "byob-attach"), "s1", "chromium"),
    ).not.toThrow();
    expect(() => refuseAttachWithoutCapability(caps("byob-attach"), "s1", "android")).not.toThrow();
  });
});

describe("byobAttachRefusal", () => {
  it("maps the refusal to the standard gate shape and ignores other errors", () => {
    const err = new ByobAttachRefused("why");
    const r = body(byobAttachRefusal(refuse, err));
    expect(r.tool).toBe("open_session");
    expect(r.requiredCapability).toBe("byob-attach");
    expect(r.reason).toBe("why");
    expect(byobAttachRefusal(refuse, new Error("other"))).toBeNull();
  });
});
