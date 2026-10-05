// `set_permission_policy` / `set_fs_picker_policy` refuse to move a policy off
// `ask-human` unless `human-gate-override` is active. Browser-free: the policy
// state classes are real, the session and gate are stubs. The real-Chromium
// proof lives in test/keystone/ask-human-gate.keystone.test.ts.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerSessionDialogPermissionTools } from "./session-dialog-permission-tools.js";
import { PermissionPolicyState } from "../session/permission-policy.js";
import { FsPickerPolicyState } from "../session/fs-picker-policy.js";
import type { Capability } from "../util/capabilities.js";
import type { SessionEntry } from "../session/registry.js";
import type { ToolResponse } from "./host.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

function setup(opts: { override: boolean; permission?: object; fsPicker?: object }) {
  const handlers: Record<string, Handler> = {};
  const permission = new PermissionPolicyState(opts.permission as never);
  const fsPicker = new FsPickerPolicyState(opts.fsPicker as never);
  const entry = {
    id: "default",
    mode: "incognito",
    permission,
    fsPicker,
    session: {
      page: () => ({
        context: () => ({
          clearPermissions: async () => undefined,
          grantPermissions: async () => undefined,
          newCDPSession: async () => ({ send: async () => undefined, detach: async () => {} }),
        }),
      }),
    },
  } as unknown as SessionEntry;
  const active = new Set<Capability>(["read", "navigation", "action", "human"]);
  if (opts.override) active.add("human-gate-override");
  const host = {
    z,
    register: (name: string, _def: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
    gateCheck: (tool: string, extra?: readonly Capability[], reason?: string) => {
      for (const cap of extra ?? []) {
        if (active.has(cap)) continue;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                tool,
                requiredCapability: cap,
                ...(reason ? { reason } : {}),
              }),
            },
          ],
        };
      }
      return null;
    },
    entryFor: async () => entry,
    workspace: { root: "/nonexistent" },
  } as unknown as Parameters<typeof registerSessionDialogPermissionTools>[0];
  registerSessionDialogPermissionTools(host);
  return { handlers, permission, fsPicker };
}

const body = (r: ToolResponse) =>
  JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

describe("set_permission_policy — ask-human gate", () => {
  it("refuses to leave ask-human without the capability and changes nothing", async () => {
    const { handlers, permission } = setup({ override: false, permission: { mode: "ask-human" } });
    const r = body(await handlers.set_permission_policy!({ mode: "allow" }));
    expect(r.ok).toBe(false);
    expect(r.requiredCapability).toBe("human-gate-override");
    expect(r.reason).toMatch(/off "ask-human"/);
    expect(permission.current()).toEqual({ mode: "ask-human" });
  });

  it("refuses a per-permission override that replaces an ask-human default", async () => {
    const { handlers, permission } = setup({ override: false, permission: { mode: "ask-human" } });
    const r = body(
      await handlers.set_permission_policy!({
        mode: "ask-human",
        perPermission: { camera: "allow" },
      }),
    );
    expect(r.requiredCapability).toBe("human-gate-override");
    expect(permission.current()).toEqual({ mode: "ask-human" });
  });

  it("refuses to replace a per-permission ask-human", async () => {
    const { handlers, permission } = setup({
      override: false,
      permission: { mode: "raise", perPermission: { camera: "ask-human" } },
    });
    const r = body(await handlers.set_permission_policy!({ mode: "allow" }));
    expect(r.requiredCapability).toBe("human-gate-override");
    expect(permission.modeFor("camera")).toBe("ask-human");
  });

  it("accepts changes that keep ask-human, and any change from a non-ask-human policy", async () => {
    const { handlers, permission } = setup({ override: false });
    expect(body(await handlers.set_permission_policy!({ mode: "allow" })).ok).toBe(true);
    expect(body(await handlers.set_permission_policy!({ mode: "ask-human" })).ok).toBe(true);
    expect(
      body(
        await handlers.set_permission_policy!({
          mode: "ask-human",
          perPermission: { camera: "ask-human", microphone: "ask-human" },
        }),
      ).ok,
    ).toBe(true);
    expect(permission.current().mode).toBe("ask-human");
  });

  it("allows leaving ask-human when the operator enabled the capability", async () => {
    const { handlers, permission } = setup({ override: true, permission: { mode: "ask-human" } });
    const r = body(await handlers.set_permission_policy!({ mode: "allow" }));
    expect(r.ok).toBe(true);
    expect(permission.current().mode).toBe("allow");
  });
});

describe("set_fs_picker_policy — ask-human gate", () => {
  it("refuses to leave ask-human without the capability and changes nothing", async () => {
    const { handlers, fsPicker } = setup({ override: false, fsPicker: { mode: "ask-human" } });
    const r = body(await handlers.set_fs_picker_policy!({ mode: "allow" }));
    expect(r.ok).toBe(false);
    expect(r.requiredCapability).toBe("human-gate-override");
    expect(fsPicker.current()).toEqual({ mode: "ask-human" });
  });

  it("refuses to replace a per-API ask-human, including through perAPI", async () => {
    const { handlers, fsPicker } = setup({
      override: false,
      fsPicker: { mode: "raise", perAPI: { showSaveFilePicker: "ask-human" } },
    });
    expect(body(await handlers.set_fs_picker_policy!({ mode: "deny" })).requiredCapability).toBe(
      "human-gate-override",
    );
    expect(
      body(
        await handlers.set_fs_picker_policy!({
          mode: "raise",
          perAPI: { showSaveFilePicker: "allow" },
        }),
      ).requiredCapability,
    ).toBe("human-gate-override");
    expect(fsPicker.modeFor("showSaveFilePicker")).toBe("ask-human");
  });

  it("accepts changes that keep ask-human, and any change from a non-ask-human policy", async () => {
    const { handlers, fsPicker } = setup({ override: false });
    expect(body(await handlers.set_fs_picker_policy!({ mode: "allow" })).ok).toBe(true);
    expect(body(await handlers.set_fs_picker_policy!({ mode: "ask-human" })).ok).toBe(true);
    expect(fsPicker.current().mode).toBe("ask-human");
  });

  it("allows leaving ask-human when the operator enabled the capability", async () => {
    const { handlers, fsPicker } = setup({ override: true, fsPicker: { mode: "ask-human" } });
    expect(body(await handlers.set_fs_picker_policy!({ mode: "allow" })).ok).toBe(true);
    expect(fsPicker.current().mode).toBe("allow");
  });
});
