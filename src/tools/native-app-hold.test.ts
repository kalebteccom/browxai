// The tool-side hold for `app_launch` and `app_install` on a real phone (RFC 0014
// G3). A fake guard and a fake human channel stand in for the phone.

import { describe, expect, it, vi } from "vitest";
import { holdNativeApp, type NativeAppHold } from "./native-app-hold.js";
import { BrowxBridge } from "../helper/bridge.js";
import { ApprovalStore, type ConfirmContext } from "../policy/confirm.js";
import type {
  NativeAppDecision,
  NativeAppGuard,
  NativeSessionHandle,
} from "../engine/native-types.js";
import type { SessionEntry } from "../session/registry.js";
import type { ConfirmHook } from "../util/capabilities.js";

const ENTRY = { id: "s1" } as unknown as SessionEntry;

/** A fake guard. `admitted` is every approval ever given; `live` is the ones not
 *  yet spent or forgotten. */
function guard(
  decision: NativeAppDecision,
): NativeAppGuard & { admitted: string[]; live: Set<string> } {
  const admitted: string[] = [];
  const live = new Set<string>();
  return {
    admitted,
    live,
    check: vi.fn(async () => decision),
    admitOnce: (verb, appId) => {
      admitted.push(`${verb}:${appId}`);
      live.add(`${verb}:${appId}`);
    },
    forget: (verb, appId) => {
      live.delete(`${verb}:${appId}`);
    },
  };
}

function handle(g?: NativeAppGuard): NativeSessionHandle {
  return { ...(g ? { appGuard: g } : {}) } as unknown as NativeSessionHandle;
}

function host(over: Partial<ConfirmContext> = {}) {
  const ctx: ConfirmContext = {
    hooks: new Set<ConfirmHook>(["native_device_app"]),
    policy: { allowed: [], blocked: [] },
    bridge: null,
    isByob: false,
    sessionId: "s1",
    ...over,
  };
  return { confirmCtxFor: () => ctx };
}

function answering(decision: "approve" | "deny"): BrowxBridge {
  return new BrowxBridge({
    operator: { ask: async () => ({ decision }), close: () => undefined },
    sessionId: "s1",
  });
}

const parse = (h: NativeAppHold) =>
  "refused" in h ? (JSON.parse(h.refused.content[0]!.text) as Record<string, unknown>) : null;

describe("holdNativeApp", () => {
  it("passes a session with no guard untouched (a simulator or an emulator)", async () => {
    expect(parse(await holdNativeApp(host(), ENTRY, handle(), "launch", "x.y"))).toBeNull();
  });

  it("passes an allowed app without asking", async () => {
    const g = guard({ kind: "allow" });
    expect(parse(await holdNativeApp(host(), ENTRY, handle(g), "launch", "a.b"))).toBeNull();
    expect(g.admitted).toEqual([]);
  });

  it("returns the guard's refusal", async () => {
    const g = guard({ kind: "refuse", error: "ios-device-system-app: no" });
    const r = parse(await holdNativeApp(host(), ENTRY, handle(g), "launch", "com.apple.MobileSMS"));
    expect(r).toEqual({ ok: false, error: "ios-device-system-app: no" });
  });

  it("refuses an app that needs a person when no person can be asked", async () => {
    const g = guard({ kind: "confirm", appId: "com.bank.app", why: "not on the list" });
    const r = parse(await holdNativeApp(host(), ENTRY, handle(g), "launch", "com.bank.app"));
    expect(r?.ok).toBe(false);
    expect(String(r?.error)).toMatch(/^policy: native_device_app:/);
    expect(String(r?.hint)).toContain("approve_actions` cannot grant");
    expect(g.admitted).toEqual([]);
  });

  it("a pre-approval from approve_actions does not admit the app", async () => {
    const approvals = new ApprovalStore();
    approvals.grant("native_device_app", 600);
    const g = guard({ kind: "confirm", appId: "com.bank.app", why: "x" });
    const r = await holdNativeApp(host({ approvals }), ENTRY, handle(g), "launch", "com.bank.app");
    expect(parse(r)?.ok).toBe(false);
    expect(g.admitted).toEqual([]);
  });

  it("admits one call after a person approves, and nothing after a denial", async () => {
    const g = guard({ kind: "confirm", appId: "com.bank.app", why: "x" });
    const yes = host({ bridge: answering("approve") });
    const held = await holdNativeApp(yes, ENTRY, handle(g), "install", "/w/B.app");
    expect(parse(held)).toBeNull();
    expect(g.admitted).toEqual(["install:com.bank.app"]);
    // The install failed before it spent the approval: release drops it.
    if (!("refused" in held)) held.release();
    expect(g.live.size).toBe(0);
    const no = host({ bridge: answering("deny") });
    const r = await holdNativeApp(no, ENTRY, handle(g), "launch", "com.bank.app");
    expect(parse(r)?.ok).toBe(false);
    expect(g.admitted).toEqual(["install:com.bank.app"]);
  });
});
