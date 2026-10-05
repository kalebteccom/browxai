import { describe, it, expect } from "vitest";
import { askHumanGrantGate, askHumanPolicyGate } from "./ask-human-gate.js";
import { WRAPPED_PERMISSIONS } from "../session/permission-policy.js";
import type { Capability } from "../util/capabilities.js";
import type { ToolResponse } from "./host.js";

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

describe("askHumanPolicyGate", () => {
  it("refuses a notification policy leaving ask-human", () => {
    const r = askHumanPolicyGate(
      refuse,
      "set_notification_policy",
      { mode: "ask-human" },
      { mode: "allow" },
      ["notifications"],
    );
    expect(body(r).requiredCapability).toBe("human-gate-override");
  });

  it("accepts keeping ask-human and any change from another mode", () => {
    const keys = ["notifications"];
    const gate = (cur: "allow" | "ask-human", next: "allow" | "ask-human" | "deny") =>
      askHumanPolicyGate(refuse, "t", { mode: cur }, { mode: next }, keys);
    expect(gate("ask-human", "ask-human")).toBeNull();
    expect(gate("allow", "deny")).toBeNull();
    expect(gate("allow", "ask-human")).toBeNull();
  });
});

describe("askHumanGrantGate", () => {
  const modeFor =
    (m: Record<string, string>, dflt = "raise") =>
    (n: string) =>
      m[n] ?? dflt;

  it("refuses a native grant of an unwrapped permission held on ask-human", () => {
    const r = askHumanGrantGate(
      refuse,
      "grant_permissions",
      ["midi", "accelerometer"],
      modeFor({ midi: "ask-human", accelerometer: "ask-human" }),
      WRAPPED_PERMISSIONS,
    );
    expect(body(r).requiredCapability).toBe("human-gate-override");
    expect(body(r).reason).toMatch(/midi, accelerometer/);
  });

  it("covers a top-level ask-human default and names outside the supported list", () => {
    const r = askHumanGrantGate(
      refuse,
      "grant_permissions",
      ["storage-access"],
      modeFor({}, "ask-human"),
      WRAPPED_PERMISSIONS,
    );
    expect(body(r).requiredCapability).toBe("human-gate-override");
  });

  it("refuses notifications: only requestPermission is wrapped, permission reads native state", () => {
    const r = askHumanGrantGate(
      refuse,
      "grant_permissions",
      ["notifications"],
      modeFor({ notifications: "ask-human" }),
      WRAPPED_PERMISSIONS,
    );
    expect(body(r).requiredCapability).toBe("human-gate-override");
    expect(WRAPPED_PERMISSIONS).not.toContain("notifications");
  });

  it("lets wrapped permissions through: the page wrapper still asks the human", () => {
    const r = askHumanGrantGate(
      refuse,
      "grant_permissions",
      ["camera", "geolocation", "clipboard-read"],
      modeFor({}, "ask-human"),
      WRAPPED_PERMISSIONS,
    );
    expect(r).toBeNull();
  });

  it("lets unwrapped permissions through when their mode is not ask-human", () => {
    const r = askHumanGrantGate(
      refuse,
      "grant_permissions",
      ["midi"],
      modeFor({ camera: "ask-human" }),
      WRAPPED_PERMISSIONS,
    );
    expect(r).toBeNull();
  });
});
