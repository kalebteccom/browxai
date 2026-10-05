import { describe, it, expect } from "vitest";
import {
  BindingGuard,
  TokenBucket,
  DEFAULT_BUDGETS,
  SHED_LOG_INTERVAL_MS,
  type BindingBudget,
  type BindingClass,
} from "./binding-guard.js";

const SMALL: Record<BindingClass, BindingBudget> = {
  decision: { burst: 3, refillPerSec: 1, maxInFlight: 2, shedReplyBurst: 1, shedReplyPerSec: 0 },
  write: { burst: 2, refillPerSec: 1, maxInFlight: 8, shedReplyBurst: 0, shedReplyPerSec: 0 },
};

function setup(budgets = SMALL) {
  let t = 1_000;
  const reports: Array<{ shed: number; bindings: Record<string, number> }> = [];
  const guard = new BindingGuard({
    now: () => t,
    budgets,
    report: (f) => reports.push({ shed: f.shed, bindings: f.bindings }),
  });
  return { guard, reports, advance: (ms: number) => (t += ms) };
}

/** True when `p` has not settled after a few microtask turns. */
async function neverSettles(p: unknown): Promise<boolean> {
  let settled = false;
  void Promise.resolve(p).then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return !settled;
}

describe("TokenBucket", () => {
  it("spends the burst, then refills with time up to the burst", () => {
    const b = new TokenBucket(2, 10, 0);
    expect([b.take(0), b.take(0), b.take(0)]).toEqual([true, true, false]);
    expect(b.take(100)).toBe(true);
    expect(b.take(100)).toBe(false);
    // A long idle stretch refills to the burst, not beyond.
    expect([b.take(60_000), b.take(60_000), b.take(60_000)]).toEqual([true, true, false]);
  });
});

describe("BindingGuard", () => {
  it("passes calls inside the budget to the handler untouched", async () => {
    const { guard, reports } = setup();
    const calls: string[] = [];
    const wrapped = guard.wrap("check", "decision", (_s, p: string) => {
      calls.push(p);
      return `ok:${p}`;
    });
    const page = {};
    expect(wrapped({ page }, "a")).toBe("ok:a");
    expect(await wrapped({ page }, "b")).toBe("ok:b");
    expect(calls).toEqual(["a", "b"]);
    expect(reports).toEqual([]);
  });

  it("answers the deny-equivalent over budget, never reaching the handler", () => {
    const { guard } = setup();
    let handled = 0;
    const wrapped = guard.wrap(
      "check",
      "decision",
      () => {
        handled++;
        return "allow";
      },
      { denyResult: () => "deny" },
    );
    const page = {};
    const out = [1, 2, 3, 4].map(() => wrapped({ page }, "{}"));
    expect(out).toEqual(["allow", "allow", "allow", "deny"]);
    expect(handled).toBe(3);
  });

  it("never settles a call beyond the deny-reply bucket, and does not call the handler", async () => {
    const { guard } = setup();
    let handled = 0;
    const wrapped = guard.wrap(
      "check",
      "decision",
      () => {
        handled++;
        return "allow";
      },
      { denyResult: () => "deny" },
    );
    const page = {};
    for (let i = 0; i < 4; i++) wrapped({ page }, "{}"); // 3 allowed + 1 deny reply
    const shed = wrapped({ page }, "{}");
    expect(await neverSettles(shed)).toBe(true);
    expect(handled).toBe(3);
  });

  it("a binding without a deny result never settles over budget", async () => {
    const { guard } = setup();
    const wrapped = guard.wrap("write", "write", () => undefined);
    const page = {};
    wrapped({ page }, "1");
    wrapped({ page }, "2");
    expect(await neverSettles(wrapped({ page }, "3"))).toBe(true);
  });

  it("keeps each page's budget separate", () => {
    const { guard } = setup();
    const wrapped = guard.wrap("check", "decision", () => "allow", { denyResult: () => "deny" });
    const a = {};
    const b = {};
    for (let i = 0; i < 3; i++) wrapped({ page: a }, "{}");
    expect(wrapped({ page: a }, "{}")).toBe("deny");
    expect(wrapped({ page: b }, "{}")).toBe("allow");
  });

  it("shares one decision budget across bindings on a page", () => {
    const { guard } = setup();
    const perm = guard.wrap("permission_check", "decision", () => "allow", {
      denyResult: () => "deny",
    });
    const note = guard.wrap("notification_check", "decision", () => "allow", {
      denyResult: () => "deny",
    });
    const page = {};
    perm({ page }, "{}");
    note({ page }, "{}");
    perm({ page }, "{}");
    expect(note({ page }, "{}")).toBe("deny");
  });

  it("refills with time", () => {
    const { guard, advance } = setup();
    const wrapped = guard.wrap("check", "decision", () => "allow", { denyResult: () => "deny" });
    const page = {};
    for (let i = 0; i < 3; i++) wrapped({ page }, "{}");
    expect(wrapped({ page }, "{}")).toBe("deny");
    advance(2_000);
    expect(wrapped({ page }, "{}")).toBe("allow");
  });

  it("sheds beyond the in-flight cap while handlers wait on a human", async () => {
    const { guard } = setup();
    const release: Array<() => void> = [];
    const wrapped = guard.wrap(
      "check",
      "decision",
      () => new Promise<string>((r) => release.push(() => r("allow"))),
      { denyResult: () => "deny" },
    );
    const page = {};
    const first = wrapped({ page }, "1");
    const second = wrapped({ page }, "2");
    // Two are waiting; the third is over the in-flight cap although tokens remain.
    expect(wrapped({ page }, "3")).toBe("deny");
    release.forEach((r) => r());
    expect(await first).toBe("allow");
    expect(await second).toBe("allow");
    // Both slots are free again; this takes the last token and runs the handler.
    release.length = 0;
    const fourth = wrapped({ page }, "4");
    expect(release.length).toBe(1);
    release[0]!();
    expect(await fourth).toBe("allow");
  });

  it("releases the in-flight slot when the handler throws", () => {
    const { guard } = setup();
    const wrapped = guard.wrap("check", "decision", () => {
      throw new Error("boom");
    });
    const page = {};
    expect(() => wrapped({ page }, "{}")).toThrow("boom");
    expect(() => wrapped({ page }, "{}")).toThrow("boom");
  });

  it("runs onShed for every shed call, and a throwing hook does not unshed it", async () => {
    const { guard } = setup();
    const seen: string[] = [];
    const wrapped = guard.wrap("write", "write", () => undefined, {
      onShed: (p) => {
        seen.push(p);
        throw new Error("hook");
      },
    });
    const page = {};
    wrapped({ page }, "a");
    wrapped({ page }, "b");
    expect(await neverSettles(wrapped({ page }, "c"))).toBe(true);
    expect(await neverSettles(wrapped({ page }, "d"))).toBe(true);
    expect(seen).toEqual(["c", "d"]);
  });

  it("logs a coalesced counter: first shed at once, then at most one per interval", () => {
    const { guard, reports, advance } = setup();
    const wrapped = guard.wrap("check", "decision", () => "allow", { denyResult: () => "deny" });
    const page = {};
    for (let i = 0; i < 3; i++) wrapped({ page }, "{}"); // spend the burst
    for (let i = 0; i < 50; i++) wrapped({ page }, "{}"); // 50 shed
    expect(reports.length).toBe(1);
    expect(reports[0]!.shed).toBe(1);
    expect(reports[0]!.bindings).toEqual({ check: 1 });
    advance(SHED_LOG_INTERVAL_MS);
    for (let i = 0; i < 4; i++) wrapped({ page }, "{}"); // 3 refilled tokens, then 1 shed
    expect(reports.length).toBe(2);
    expect(reports[1]!.shed).toBe(50);
  });

  it("falls back to one shared budget when the source carries no page", () => {
    const { guard } = setup();
    const wrapped = guard.wrap("check", "decision", () => "allow", { denyResult: () => "deny" });
    for (let i = 0; i < 3; i++) wrapped({}, "{}");
    expect(wrapped({}, "{}")).toBe("deny");
  });

  it("the default decision budget leaves room for normal use", () => {
    const b = DEFAULT_BUDGETS.decision;
    expect(b.burst).toBeGreaterThanOrEqual(50);
    expect(b.shedReplyBurst).toBeGreaterThan(0);
    expect(DEFAULT_BUDGETS.write.shedReplyBurst).toBe(0);
  });
});
