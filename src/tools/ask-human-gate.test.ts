import { describe, it, expect } from "vitest";
import {
  AskHumanProfileRefused,
  askHumanGrantGate,
  askHumanPolicyGate,
  askHumanProfileRefusal,
  askHumanReopenGate,
  refuseHeldProfile,
} from "./ask-human-gate.js";
import { WRAPPED_PERMISSIONS } from "../session/permission-policy.js";
import type { Capability, CapabilityConfig } from "../util/capabilities.js";
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

describe("refuseHeldProfile", () => {
  const held = { profileDir: "/ws/profiles/p", permission: { mode: "ask-human" as const } };
  const registry = { heldOnProfile: (d: string) => (d === "/ws/profiles/p" ? held : undefined) };
  const caps = (...on: string[]) => ({ enabled: new Set(on) }) as unknown as CapabilityConfig;

  it("refuses another name on a held profile, defaults included", () => {
    expect(() => refuseHeldProfile(registry, caps(), "x", "/ws/profiles/p", undefined)).toThrow(
      AskHumanProfileRefused,
    );
    expect(() =>
      refuseHeldProfile(registry, caps(), "x", "/ws/profiles/p", {
        permissionPolicy: { mode: "allow" },
      }),
    ).toThrow(/permissionPolicy/);
  });

  it("lets through ask-human, another profile, or human-gate-override", () => {
    const keep = { permissionPolicy: { mode: "ask-human" as const } };
    expect(() => refuseHeldProfile(registry, caps(), "x", "/ws/profiles/p", keep)).not.toThrow();
    expect(() =>
      refuseHeldProfile(registry, caps(), "x", "/ws/profiles/q", undefined),
    ).not.toThrow();
    expect(() =>
      refuseHeldProfile(registry, caps("human-gate-override"), "x", "/ws/profiles/p", undefined),
    ).not.toThrow();
  });

  it("maps the error to the standard gate refusal and ignores other errors", () => {
    const err = new AskHumanProfileRefused("why");
    expect(body(askHumanProfileRefusal(refuse, err)).requiredCapability).toBe(
      "human-gate-override",
    );
    expect(askHumanProfileRefusal(refuse, new Error("other"))).toBeNull();
  });
});

describe("askHumanReopenGate", () => {
  const held = {
    permission: { mode: "ask-human" as const },
    notification: { mode: "ask-human" as const },
    fsPicker: { mode: "ask-human" as const, perAPI: { showSaveFilePicker: "deny" as const } },
  };

  it("lets a name that held nothing open with any policy", () => {
    const r = askHumanReopenGate(refuse, "s", undefined, { permission: { mode: "allow" } });
    expect(r).toBeNull();
  });

  it("lets a reopen that names no policy through: the hold is inherited", () => {
    expect(askHumanReopenGate(refuse, "s", held, {})).toBeNull();
  });

  it("lets a reopen that keeps ask-human through", () => {
    const r = askHumanReopenGate(refuse, "s", held, {
      permission: { mode: "ask-human", perPermission: { camera: "ask-human" } },
      notification: { mode: "ask-human" },
      fsPicker: { mode: "ask-human" },
    });
    expect(r).toBeNull();
    // A key the old policy already took off ask-human may move again.
    const second = askHumanReopenGate(refuse, "s", held, {
      fsPicker: { mode: "ask-human", perAPI: { showSaveFilePicker: "allow" } },
    });
    expect(second).toBeNull();
  });

  it("refuses a policy that leaves ask-human and names each one", () => {
    const r = askHumanReopenGate(refuse, "s", held, {
      permission: { mode: "allow" },
      notification: { mode: "deny" },
      fsPicker: { mode: "ask-human", perAPI: { showOpenFilePicker: "allow" } },
    });
    expect(body(r).requiredCapability).toBe("human-gate-override");
    expect(body(r).tool).toBe("open_session");
    expect(body(r).reason).toMatch(/permissionPolicy.*notificationPolicy.*fsPickerPolicy/);
  });

  it("does not touch a policy the name did not hold", () => {
    const r = askHumanReopenGate(
      refuse,
      "s",
      { permission: { mode: "ask-human" } },
      { notification: { mode: "allow" }, fsPicker: { mode: "allow" } },
    );
    expect(r).toBeNull();
  });
});
