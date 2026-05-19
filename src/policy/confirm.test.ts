import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalStore, confirmNavigation, confirmByobAction, type ConfirmContext } from "./confirm.js";
import type { OriginPolicy } from "./origin.js";

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
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

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

  it("falls back to bridge-blocked path when no grant is present", async () => {
    // No bridge + no approvals + byob_action hook → blocked (would need page-side confirm).
    const decision = await confirmByobAction("click", ctx({ approvals: new ApprovalStore() }));
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("no helper bridge");
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
      allowed: [{ raw: "https://safe.example.com", test: (u) => u.origin === "https://safe.example.com" }],
      blocked: [],
    };
    const decision = await confirmNavigation("https://other.example.com/x", ctx({ policy, approvals, isByob: false }));
    expect(decision.ok).toBe(true);
    expect(decision.reason).toContain("pre-approved");
  });

  it("on-allowlist navigation is always approved (pre-approval not consulted)", async () => {
    const approvals = new ApprovalStore();
    const policy: OriginPolicy = {
      allowed: [{ raw: "https://safe.example.com", test: (u) => u.origin === "https://safe.example.com" }],
      blocked: [],
    };
    const decision = await confirmNavigation("https://safe.example.com/x", ctx({ policy, approvals, isByob: false }));
    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe("on-allowlist");
  });
});
