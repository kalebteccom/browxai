import { describe, it, expect, vi, afterEach } from "vitest";
import type { Page } from "playwright-core";
import {
  AttachLeaseTable,
  DEFAULT_ATTACH_LEASE_TTL_MS,
  DEFAULT_ATTACH_POOL_MAX,
  acquireTarget,
  attachLeaseTtlMs,
  attachPoolExhausted,
  attachPoolMax,
  attachTargetGone,
  attachLeases,
  touchAttachLease,
  releaseTarget,
  type PoolTarget,
  type TargetSource,
} from "./attach-pool.js";

interface FakePage {
  close: ReturnType<typeof vi.fn>;
  isClosed: () => boolean;
}

function fakePage(closed = false): FakePage {
  let isClosed = closed;
  return {
    close: vi.fn(async () => {
      isClosed = true;
    }),
    isClosed: () => isClosed,
  };
}

function target(targetId: string, page: FakePage): PoolTarget {
  return { targetId, page: page as unknown as Page };
}

function source(existing: PoolTarget[], minted: PoolTarget[] = []): TargetSource {
  const queue = [...minted];
  return {
    list: () => Promise.resolve(existing),
    create: () => {
      const next = queue.shift();
      if (!next) throw new Error("test source: no target left to create");
      existing.push(next);
      return Promise.resolve(next);
    },
  };
}

const ENDPOINT = "http://127.0.0.1:9222";

describe("AttachLeaseTable", () => {
  it("claims a lease and reports it as taken on its endpoint", () => {
    const leases = new AttachLeaseTable();
    const lease = leases.claim({
      sessionId: "a",
      targetId: "T1",
      endpoint: ENDPOINT,
      owned: false,
    });
    expect(lease.acquiredAt).toBe(lease.renewedAt);
    expect(leases.leasedTargets(ENDPOINT)).toEqual(new Set(["T1"]));
    expect(leases.leasedTargets("http://127.0.0.1:9333")).toEqual(new Set());
  });

  it("releases a lease and frees its target", () => {
    const leases = new AttachLeaseTable();
    leases.claim({ sessionId: "a", targetId: "T1", endpoint: ENDPOINT, owned: false });
    expect(leases.release("a")?.targetId).toBe("T1");
    expect(leases.release("a")).toBeUndefined();
    expect(leases.leasedTargets(ENDPOINT).size).toBe(0);
  });

  it("renews on demand and reports nothing for an unknown session", () => {
    const leases = new AttachLeaseTable();
    leases.claim({ sessionId: "a", targetId: "T1", endpoint: ENDPOINT, owned: false, now: 1_000 });
    expect(leases.renew("a", 4_000)?.renewedAt).toBe(4_000);
    expect(leases.renew("missing", 4_000)).toBeUndefined();
  });

  it("never expires a lease on elapsed time alone", () => {
    const leases = new AttachLeaseTable();
    leases.claim({ sessionId: "a", targetId: "T1", endpoint: ENDPOINT, owned: false, now: 1_000 });
    expect(leases.renew("a", 9_999_999)?.renewedAt).toBe(9_999_999);
  });

  it("reclaims only the leases idle past the TTL", () => {
    const leases = new AttachLeaseTable();
    leases.claim({ sessionId: "idle", targetId: "T1", endpoint: ENDPOINT, owned: false, now: 0 });
    leases.claim({ sessionId: "busy", targetId: "T2", endpoint: ENDPOINT, owned: false, now: 0 });
    leases.renew("busy", 19_000);
    const dead = leases.reclaimExpired(ENDPOINT, 5_000, 20_000);
    expect(dead.map((l) => l.sessionId)).toEqual(["idle"]);
    expect(leases.get("busy")).toBeDefined();
    expect(leases.get("idle")).toBeUndefined();
  });

  it("leaves another endpoint's idle leases alone", () => {
    const leases = new AttachLeaseTable();
    leases.claim({ sessionId: "a", targetId: "T1", endpoint: ENDPOINT, owned: false, now: 0 });
    leases.claim({
      sessionId: "b",
      targetId: "T2",
      endpoint: "http://127.0.0.1:9333",
      owned: false,
      now: 0,
    });
    leases.reclaimExpired(ENDPOINT, 5_000, 20_000);
    expect(leases.get("b")).toBeDefined();
  });
});

describe("acquireTarget", () => {
  it("gives two distinct sessions two distinct targets", async () => {
    const leases = new AttachLeaseTable();
    const src = source([target("T1", fakePage()), target("T2", fakePage())]);
    const a = await acquireTarget(leases, src, { sessionId: "a", endpoint: ENDPOINT });
    const b = await acquireTarget(leases, src, { sessionId: "b", endpoint: ENDPOINT });
    expect(a.targetId).toBe("T1");
    expect(b.targetId).toBe("T2");
    expect(a.created).toBe(false);
    expect(b.created).toBe(false);
  });

  it("serializes concurrent acquisitions so neither claims the same target", async () => {
    const leases = new AttachLeaseTable();
    const src = source([target("T1", fakePage()), target("T2", fakePage())]);
    const [a, b] = await Promise.all([
      acquireTarget(leases, src, { sessionId: "a", endpoint: ENDPOINT }),
      acquireTarget(leases, src, { sessionId: "b", endpoint: ENDPOINT }),
    ]);
    expect(new Set([a.targetId, b.targetId]).size).toBe(2);
  });

  it("creates a target when every existing one is leased", async () => {
    const leases = new AttachLeaseTable();
    const src = source([target("T1", fakePage())], [target("T2", fakePage())]);
    await acquireTarget(leases, src, { sessionId: "a", endpoint: ENDPOINT });
    const b = await acquireTarget(leases, src, { sessionId: "b", endpoint: ENDPOINT });
    expect(b.targetId).toBe("T2");
    expect(b.created).toBe(true);
  });

  it("skips a closed target rather than leasing a dead page", async () => {
    const leases = new AttachLeaseTable();
    const src = source([target("T1", fakePage(true)), target("T2", fakePage())]);
    const a = await acquireTarget(leases, src, { sessionId: "a", endpoint: ENDPOINT });
    expect(a.targetId).toBe("T2");
  });

  it("reports attach-target-gone when the only claimable target is already dead", async () => {
    const leases = new AttachLeaseTable();
    const dead = target("T9", fakePage(true));
    await expect(
      acquireTarget(leases, source([], [dead]), { sessionId: "a", endpoint: ENDPOINT }),
    ).rejects.toThrow(/attach-target-gone/);
  });

  it("leases the same target id independently per endpoint", async () => {
    const leases = new AttachLeaseTable();
    const one = source([target("T1", fakePage())]);
    const two = source([target("T1", fakePage())]);
    await acquireTarget(leases, one, { sessionId: "a", endpoint: ENDPOINT });
    const b = await acquireTarget(leases, two, { sessionId: "b", endpoint: "android://SERIAL" });
    expect(b.targetId).toBe("T1");
    expect(b.created).toBe(false);
  });
});

describe("releaseTarget", () => {
  it("closes a target the session created", async () => {
    const leases = new AttachLeaseTable();
    const page = fakePage();
    const src = source([], [target("T1", page)]);
    const acquired = await acquireTarget(leases, src, { sessionId: "a", endpoint: ENDPOINT });
    expect(acquired.created).toBe(true);
    await releaseTarget(leases, "a", acquired.page);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(leases.leasedTargets(ENDPOINT).size).toBe(0);
  });

  it("leaves a pre-existing target the session merely claimed open", async () => {
    const leases = new AttachLeaseTable();
    const page = fakePage();
    const src = source([target("T1", page)]);
    const acquired = await acquireTarget(leases, src, { sessionId: "a", endpoint: ENDPOINT });
    expect(acquired.created).toBe(false);
    await releaseTarget(leases, "a", acquired.page);
    expect(page.close).not.toHaveBeenCalled();
    expect(leases.leasedTargets(ENDPOINT).size).toBe(0);
  });

  it("is a no-op for a session that holds no lease", async () => {
    const leases = new AttachLeaseTable();
    const page = fakePage();
    await releaseTarget(leases, "nobody", page as unknown as Page);
    expect(page.close).not.toHaveBeenCalled();
  });
});

describe("pool limits and structured errors", () => {
  it("reads the TTL and ceiling from env, falling back to the defaults", () => {
    vi.stubEnv("BROWX_ATTACH_LEASE_TTL_MS", undefined);
    vi.stubEnv("BROWX_ATTACH_POOL_MAX", undefined);
    expect(attachLeaseTtlMs()).toBe(DEFAULT_ATTACH_LEASE_TTL_MS);
    expect(attachPoolMax()).toBe(DEFAULT_ATTACH_POOL_MAX);
    vi.stubEnv("BROWX_ATTACH_LEASE_TTL_MS", "1234");
    vi.stubEnv("BROWX_ATTACH_POOL_MAX", "3");
    expect(attachLeaseTtlMs()).toBe(1234);
    expect(attachPoolMax()).toBe(3);
    vi.stubEnv("BROWX_ATTACH_POOL_MAX", "not-a-number");
    expect(attachPoolMax()).toBe(DEFAULT_ATTACH_POOL_MAX);
    vi.unstubAllEnvs();
  });

  it("names the session and target in attach-target-gone", () => {
    expect(attachTargetGone("agent-a", "T1").message).toMatch(/attach-target-gone.*agent-a.*T1/);
  });

  it("names the ceiling and the live leases in attach-pool-exhausted", () => {
    const leases = new AttachLeaseTable();
    leases.claim({ sessionId: "a", targetId: "T1", endpoint: ENDPOINT, owned: false });
    const err = attachPoolExhausted(ENDPOINT, 1, leases.forEndpoint(ENDPOINT));
    expect(err.message).toMatch(/attach-pool-exhausted/);
    expect(err.message).toContain("a→T1");
    expect(err.message).toContain("1-target ceiling");
  });
});

describe("pool ceiling", () => {
  it("refuses acquisition once the endpoint is at BROWX_ATTACH_POOL_MAX", async () => {
    vi.stubEnv("BROWX_ATTACH_POOL_MAX", "2");
    const leases = new AttachLeaseTable();
    const pages = [fakePage(), fakePage(), fakePage()];
    const source: TargetSource = {
      list: async () => pages.map((p, i) => target(`T${i}`, p)),
      create: async () => target("T-new", fakePage()),
    };
    const ep = "http://127.0.0.1:9400";
    await acquireTarget(leases, source, { sessionId: "a", endpoint: ep });
    await acquireTarget(leases, source, { sessionId: "b", endpoint: ep });
    await expect(acquireTarget(leases, source, { sessionId: "c", endpoint: ep })).rejects.toThrow(
      /attach-pool-exhausted/,
    );
    vi.unstubAllEnvs();
  });

  it("frees a slot by reclaiming an idle lease rather than refusing", async () => {
    vi.stubEnv("BROWX_ATTACH_POOL_MAX", "1");
    vi.stubEnv("BROWX_ATTACH_LEASE_TTL_MS", "1");
    const leases = new AttachLeaseTable();
    const source: TargetSource = {
      list: async () => [target("T0", fakePage())],
      create: async () => target("T-new", fakePage()),
    };
    const ep = "http://127.0.0.1:9401";
    await acquireTarget(leases, source, { sessionId: "stale", endpoint: ep });
    await new Promise((r) => setTimeout(r, 5));
    const second = await acquireTarget(leases, source, { sessionId: "fresh", endpoint: ep });
    expect(second.targetId).toBeTruthy();
    expect(leases.get("stale")).toBeUndefined();
    expect(leases.get("fresh")).toBeDefined();
    vi.unstubAllEnvs();
  });
});

describe("touchAttachLease", () => {
  const EP = "http://127.0.0.1:9500";
  afterEach(() => {
    for (const l of attachLeases.list()) attachLeases.release(l.sessionId);
  });

  it("renews the lease of a session still holding its target", () => {
    attachLeases.claim({ sessionId: "live", targetId: "T1", endpoint: EP, owned: false, now: 0 });
    expect(() => touchAttachLease("live", "T1")).not.toThrow();
    expect(attachLeases.get("live")!.renewedAt).toBeGreaterThan(0);
  });

  it("refuses when the lease was reclaimed out from under the session", () => {
    attachLeases.claim({ sessionId: "gone", targetId: "T1", endpoint: EP, owned: false, now: 0 });
    attachLeases.release("gone");
    expect(() => touchAttachLease("gone", "T1")).toThrow(/attach-lease-expired/);
  });

  it("refuses when another session now holds that target id", () => {
    attachLeases.claim({ sessionId: "s", targetId: "T2", endpoint: EP, owned: false, now: 0 });
    expect(() => touchAttachLease("s", "T1")).toThrow(/attach-lease-expired/);
  });
});
