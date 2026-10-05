import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApprovalStore,
  confirmNavigation,
  confirmByobAction,
  type ConfirmContext,
} from "./confirm.js";
import { resolveOriginPolicy, type OriginPolicy } from "./origin.js";
import { BrowxBridge } from "../helper/bridge.js";

const NO_POLICY: OriginPolicy = { allowed: [], blocked: [] };

function ctx(over: Partial<ConfirmContext> = {}): ConfirmContext {
  return {
    hooks: new Set(["navigate_off_allowlist", "byob_action"]),
    policy: NO_POLICY,
    bridge: null,
    isByob: true,
    ...over,
  };
}

describe("ApprovalStore — session pre-approvals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("grants a scope and consumes it within the TTL", () => {
    vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));
    const store = new ApprovalStore();
    store.grant("byob_action", 3600);
    expect(store.consume("byob_action")).toBe(true);
  });

  it("consume returns false for an unknown scope without affecting the store", () => {
    const store = new ApprovalStore();
    expect(store.consume("byob_action")).toBe(false);
    store.grant("byob_action", 60);
    expect(store.consume("byob_action")).toBe(true);
  });

  it("evicts and rejects an expired grant", () => {
    vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));
    const store = new ApprovalStore();
    store.grant("byob_action", 60);
    vi.setSystemTime(new Date("2026-05-15T10:02:00Z"));
    expect(store.consume("byob_action")).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("counts consume() calls for audit", () => {
    vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));
    const store = new ApprovalStore();
    store.grant("byob_action", 3600);
    store.consume("byob_action");
    store.consume("byob_action");
    store.consume("byob_action");
    expect(store.list()[0]?.uses).toBe(3);
  });

  it("revoke removes a live grant and returns true; false otherwise", () => {
    const store = new ApprovalStore();
    expect(store.revoke("byob_action")).toBe(false);
    store.grant("byob_action", 60);
    expect(store.revoke("byob_action")).toBe(true);
    expect(store.consume("byob_action")).toBe(false);
  });

  it("re-granting an existing scope resets the TTL window", () => {
    vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));
    const store = new ApprovalStore();
    store.grant("byob_action", 60);
    vi.setSystemTime(new Date("2026-05-15T10:00:30Z"));
    store.grant("byob_action", 600); // 10 minutes
    vi.setSystemTime(new Date("2026-05-15T10:01:30Z")); // 90s past original grant
    expect(store.consume("byob_action")).toBe(true);
  });
});

describe("confirmByobAction with pre-approval", () => {
  it("auto-approves when a live grant covers the scope", async () => {
    const approvals = new ApprovalStore();
    approvals.grant("byob_action", 60);
    const decision = await confirmByobAction("click", ctx({ approvals }));
    expect(decision.ok).toBe(true);
    expect(decision.reason).toContain("pre-approved");
    expect(decision.asked).toBe(false);
  });

  it("falls back to the blocked path when no grant is present", async () => {
    // No bridge + no approvals + byob_action hook → blocked (would need a human).
    const decision = await confirmByobAction("click", ctx({ approvals: new ApprovalStore() }));
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("no human channel");
  });

  it("fails closed when the bridge has no human channel (an engine without CDP)", async () => {
    // A fresh, unattached bridge carries no isolated-world channel. The hook must
    // block without waiting, not fall back to anything the page can reach.
    const bridge = new BrowxBridge();
    const byob = await confirmByobAction("click", ctx({ bridge }));
    expect(byob).toEqual({
      ok: false,
      reason: "byob; no human channel on this session to confirm; blocked",
      asked: false,
    });
    const nav = await confirmNavigation(
      "https://off.example/",
      ctx({
        bridge,
        policy: resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: "https://on.example" }),
      }),
    );
    expect(nav.ok).toBe(false);
    expect(nav.asked).toBe(false);
  });

  it("passes through for non-BYOB sessions regardless of approvals", async () => {
    const approvals = new ApprovalStore();
    const decision = await confirmByobAction("click", ctx({ isByob: false, approvals }));
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe("not byob");
  });
});

describe("confirmNavigation with pre-approval", () => {
  it("auto-approves off-allowlist navigation when a live grant covers it", async () => {
    const approvals = new ApprovalStore();
    approvals.grant("navigate_off_allowlist", 60);
    const policy: OriginPolicy = {
      allowed: [
        { raw: "https://safe.example.com", test: (u) => u.origin === "https://safe.example.com" },
      ],
      blocked: [],
    };
    const decision = await confirmNavigation(
      "https://other.example.com/x",
      ctx({ policy, approvals, isByob: false }),
    );
    expect(decision.ok).toBe(true);
    expect(decision.reason).toContain("pre-approved");
  });

  it("on-allowlist navigation is always approved (pre-approval not consulted)", async () => {
    const approvals = new ApprovalStore();
    const policy: OriginPolicy = {
      allowed: [
        { raw: "https://safe.example.com", test: (u) => u.origin === "https://safe.example.com" },
      ],
      blocked: [],
    };
    const decision = await confirmNavigation(
      "https://safe.example.com/x",
      ctx({ policy, approvals, isByob: false }),
    );
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe("on-allowlist");
  });
});

describe("ApprovalStore — session and workspace scope", () => {
  it("a session grant covers that session only", () => {
    const store = new ApprovalStore();
    store.grant("byob_action", 60, "alpha");
    expect(store.consume("byob_action", "alpha")).toBe(true);
    expect(store.consume("byob_action", "beta")).toBe(false);
    expect(store.consume("byob_action")).toBe(false);
  });

  it("a workspace grant covers every session", () => {
    const store = new ApprovalStore();
    store.grant("byob_action", 60);
    expect(store.consume("byob_action", "alpha")).toBe(true);
    expect(store.consume("byob_action", "beta")).toBe(true);
    expect(store.consume("byob_action")).toBe(true);
  });

  it("revokeSession drops that session's grants and leaves the rest", () => {
    const store = new ApprovalStore();
    store.grant("byob_action", 60, "alpha");
    store.grant("navigate_off_allowlist", 60, "alpha");
    store.grant("byob_action", 60, "beta");
    store.grant("byob_action", 60);
    expect(store.revokeSession("alpha")).toBe(2);
    expect(store.consume("navigate_off_allowlist", "alpha")).toBe(false);
    expect(store.consume("byob_action", "beta")).toBe(true);
    expect(store.consume("byob_action", "alpha")).toBe(true); // via the workspace grant
  });

  it("lists the session a grant belongs to", () => {
    const store = new ApprovalStore();
    store.grant("byob_action", 60, "alpha");
    store.grant("navigate_off_allowlist", 60);
    const rows = store.list();
    expect(rows.find((r) => r.scope === "byob_action")?.sessionId).toBe("alpha");
    expect(rows.find((r) => r.scope === "navigate_off_allowlist")).not.toHaveProperty("sessionId");
  });
});

describe("confirm hooks over the operator channel", () => {
  type Answer =
    | {
        decision: "approve" | "deny" | "abort";
        grant?: { scope: "session" | "workspace"; ttlSeconds: number };
      }
    | Error;

  function operatorBridge(answers: Answer[]) {
    const ask = vi.fn(async () => {
      const a = answers.shift();
      if (!a) throw new Error("no more answers");
      if (a instanceof Error) throw a;
      return a;
    });
    const bridge = new BrowxBridge({
      operator: { ask, close: () => undefined },
      sessionId: "alpha",
    });
    return { bridge, ask };
  }

  it("asks with the hook's scope, tool and a summary, and approves on approve", async () => {
    const { bridge, ask } = operatorBridge([{ decision: "approve" }]);
    const decision = await confirmByobAction("click", ctx({ bridge, sessionId: "alpha" }));
    expect(decision).toEqual({ ok: true, reason: "human-approved", asked: true });
    expect(ask).toHaveBeenCalledOnce();
    const req = (ask.mock.calls[0] as unknown as [{ prompt: unknown; session: string }])[0];
    expect(req.session).toBe("alpha");
    expect(req.prompt).toMatchObject({
      kind: "approval",
      scope: "byob_action",
      tool: "click",
      grantable: "byob_action",
    });
  });

  it("refuses on deny", async () => {
    const { bridge } = operatorBridge([{ decision: "deny" }]);
    const decision = await confirmByobAction("click", ctx({ bridge }));
    expect(decision).toEqual({ ok: false, reason: "human-declined", asked: true });
  });

  it("refuses on abort and on a timeout", async () => {
    const { bridge } = operatorBridge([
      { decision: "abort" },
      new Error("awaitHuman timed out after 300000ms (no operator answer)"),
    ]);
    expect((await confirmByobAction("click", ctx({ bridge }))).ok).toBe(false);
    const timedOut = await confirmByobAction("click", ctx({ bridge }));
    expect(timedOut.ok).toBe(false);
    expect(timedOut.reason).toContain("timed out");
  });

  it("an approve is one-shot: the next call asks again", async () => {
    const approvals = new ApprovalStore();
    const { bridge, ask } = operatorBridge([{ decision: "approve" }, { decision: "deny" }]);
    const c = ctx({ bridge, approvals, sessionId: "alpha" });
    expect((await confirmByobAction("click", c)).ok).toBe(true);
    expect((await confirmByobAction("click", c)).ok).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(approvals.list()).toHaveLength(0);
  });

  it("a session grant covers the same session's later calls and no other session", async () => {
    const approvals = new ApprovalStore();
    const { bridge, ask } = operatorBridge([
      { decision: "approve", grant: { scope: "session", ttlSeconds: 600 } },
      { decision: "deny" },
    ]);
    const first = await confirmByobAction("click", ctx({ bridge, approvals, sessionId: "alpha" }));
    expect(first.ok).toBe(true);
    const again = await confirmByobAction("press", ctx({ bridge, approvals, sessionId: "alpha" }));
    expect(again).toMatchObject({ ok: true, reason: "pre-approved", asked: false });
    const other = await confirmByobAction("click", ctx({ bridge, approvals, sessionId: "beta" }));
    expect(other.ok).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("a workspace grant covers other sessions too", async () => {
    const approvals = new ApprovalStore();
    const { bridge } = operatorBridge([
      { decision: "approve", grant: { scope: "workspace", ttlSeconds: 600 } },
    ]);
    await confirmByobAction("click", ctx({ bridge, approvals, sessionId: "alpha" }));
    const other = await confirmByobAction("click", ctx({ bridge, approvals, sessionId: "beta" }));
    expect(other).toMatchObject({ ok: true, reason: "pre-approved" });
  });

  it("drops a session grant when the call has no session, never widening it", async () => {
    const approvals = new ApprovalStore();
    const { bridge } = operatorBridge([
      { decision: "approve", grant: { scope: "session", ttlSeconds: 600 } },
    ]);
    expect((await confirmByobAction("click", ctx({ bridge, approvals }))).ok).toBe(true);
    expect(approvals.list()).toHaveLength(0);
  });

  it("a deny never stores a grant", async () => {
    const approvals = new ApprovalStore();
    const { bridge } = operatorBridge([
      { decision: "deny", grant: { scope: "workspace", ttlSeconds: 600 } },
    ]);
    await confirmByobAction("click", ctx({ bridge, approvals, sessionId: "alpha" }));
    expect(approvals.list()).toHaveLength(0);
  });

  it("asks for navigation with the navigate scope", async () => {
    const { bridge, ask } = operatorBridge([{ decision: "approve" }]);
    const decision = await confirmNavigation(
      "https://off.example/",
      ctx({
        bridge,
        isByob: false,
        policy: resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: "https://on.example" }),
      }),
    );
    expect(decision.ok).toBe(true);
    const req = (ask.mock.calls[0] as unknown as [{ prompt: { scope: string; tool: string } }])[0];
    expect(req.prompt).toMatchObject({ scope: "navigate_off_allowlist", tool: "navigate" });
  });
});
