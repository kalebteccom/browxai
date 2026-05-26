import { describe, it, expect, vi } from "vitest";
import { SessionRegistry, DEFAULT_SESSION_ID, type SessionEntry } from "./registry.js";
import { WedgeTracker } from "./wedge.js";
import { SessionMetrics } from "./metrics.js";
import { DialogPolicyState } from "./dialog.js";
import { newEmulationState } from "./emulation.js";
import { newHarRecorderState } from "../page/har.js";

// Fake entry — only the registry's own bookkeeping is under test here; the
// browser wiring is exercised by integration, not unit, tests.
function fakeEntry(id: string): SessionEntry {
  return {
    id,
    mode: "persistent",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session: { close: vi.fn(async () => undefined) } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refs: { __tag: `refs-${id}` } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    network: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ws: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bridge: { detach: vi.fn(async () => undefined) } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recorder: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    feedback: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clipboard: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    routes: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emulation: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clock: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    seededRandom: {} as any,
    perf: {} as any,
    wedge: new WedgeTracker(),
    metrics: new SessionMetrics(),
    dialog: new DialogPolicyState(),
    deviceEmulation: newEmulationState(),
    har: newHarRecorderState(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    secrets: {} as any,
    extensions: { loaded: [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    downloads: {} as any,
    openedAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

describe("SessionRegistry", () => {
  it("lazily creates the default entry on first get()", async () => {
    const factory = vi.fn(async (id: string) => fakeEntry(id));
    const reg = new SessionRegistry(factory, async () => undefined);
    expect(reg.has(DEFAULT_SESSION_ID)).toBe(false);
    const e = await reg.get();
    expect(e.id).toBe("default");
    expect(reg.has("default")).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("returns the same entry on repeated get() (no second factory call)", async () => {
    const factory = vi.fn(async (id: string) => fakeEntry(id));
    const reg = new SessionRegistry(factory, async () => undefined);
    const a = await reg.get("s1");
    const b = await reg.get("s1");
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("distinct ids get isolated entries (own refs)", async () => {
    const reg = new SessionRegistry(async (id) => fakeEntry(id), async () => undefined);
    const a = await reg.get("agent-a");
    const b = await reg.get("agent-b");
    expect(a).not.toBe(b);
    expect(a.refs).not.toBe(b.refs);
    expect((a.refs as unknown as { __tag: string }).__tag).toBe("refs-agent-a");
    expect((b.refs as unknown as { __tag: string }).__tag).toBe("refs-agent-b");
  });

  it("concurrent first-calls for the same id share one factory invocation", async () => {
    let resolve!: (e: SessionEntry) => void;
    const factory = vi.fn(
      () => new Promise<SessionEntry>((r) => { resolve = r; }),
    );
    const reg = new SessionRegistry(factory, async () => undefined);
    const p1 = reg.get("x");
    const p2 = reg.get("x");
    resolve(fakeEntry("x"));
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1).toBe(e2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("a failed creation does not poison the id — next get() retries", async () => {
    let attempt = 0;
    const factory = vi.fn(async (id: string) => {
      attempt++;
      if (attempt === 1) throw new Error("launch failed");
      return fakeEntry(id);
    });
    const reg = new SessionRegistry(factory, async () => undefined);
    await expect(reg.get("flaky")).rejects.toThrow("launch failed");
    const e = await reg.get("flaky"); // retry succeeds
    expect(e.id).toBe("flaky");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("close() tears down + removes; returns false when not open", async () => {
    const teardown = vi.fn(async () => undefined);
    const reg = new SessionRegistry(async (id) => fakeEntry(id), teardown);
    expect(await reg.close("ghost")).toBe(false);
    const e = await reg.get("real");
    expect(await reg.close("real")).toBe(true);
    expect(teardown).toHaveBeenCalledWith(e);
    expect(reg.has("real")).toBe(false);
  });

  it("closeAll tears down every live entry", async () => {
    const teardown = vi.fn(async () => undefined);
    const reg = new SessionRegistry(async (id) => fakeEntry(id), teardown);
    await reg.get("a");
    await reg.get("b");
    await reg.closeAll();
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(reg.list()).toHaveLength(0);
  });

  it("closeMatching({ prefix }) tears down only id-prefixed sessions", async () => {
    const teardown = vi.fn(async () => undefined);
    const reg = new SessionRegistry(async (id) => fakeEntry(id), teardown);
    await reg.get("agentA-host");
    await reg.get("agentA-fan1");
    await reg.get("agentB-host");
    const closed = await reg.closeMatching({ prefix: "agentA-" });
    expect(closed.sort()).toEqual(["agentA-fan1", "agentA-host"]);
    expect(reg.list().map((e) => e.id)).toEqual(["agentB-host"]);
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it("closeMatching({ all:true }) tears everything down", async () => {
    const reg = new SessionRegistry(async (id) => fakeEntry(id), async () => undefined);
    await reg.get("x"); await reg.get("y");
    expect((await reg.closeMatching({ all: true })).sort()).toEqual(["x", "y"]);
    expect(reg.list()).toHaveLength(0);
  });

  it("closeMatching({ idleMs }) reaps only stale sessions; get() touches activity", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-19T10:00:00Z"));
      const reg = new SessionRegistry(async (id) => fakeEntry(id), async () => undefined);
      await reg.get("stale");
      await reg.get("fresh");
      vi.setSystemTime(new Date("2026-05-19T10:05:00Z")); // +5min
      await reg.get("fresh"); // touch — resets lastActivityAt to now
      const closed = await reg.closeMatching({ idleMs: 60_000 }); // idle > 1min
      expect(closed).toEqual(["stale"]);
      expect(reg.peek("fresh")?.id).toBe("fresh");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closeMatching ANDs prefix + idleMs", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-19T10:00:00Z"));
      const reg = new SessionRegistry(async (id) => fakeEntry(id), async () => undefined);
      await reg.get("a-1");        // matches prefix, will be idle
      await reg.get("b-1");        // idle but wrong prefix
      vi.setSystemTime(new Date("2026-05-19T10:10:00Z"));
      const closed = await reg.closeMatching({ prefix: "a-", idleMs: 60_000 });
      expect(closed).toEqual(["a-1"]);
      expect(reg.peek("b-1")?.id).toBe("b-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("peek() never creates; list() reflects live entries", async () => {
    const reg = new SessionRegistry(async (id) => fakeEntry(id), async () => undefined);
    expect(reg.peek("nope")).toBeUndefined();
    await reg.get("one");
    await reg.get("two");
    expect(reg.list().map((e) => e.id).sort()).toEqual(["one", "two"]);
    expect(reg.peek("one")?.id).toBe("one");
  });

  it("passes the OpenSpec through to the factory on creation only", async () => {
    const factory = vi.fn(async (id: string) => fakeEntry(id));
    const reg = new SessionRegistry(factory, async () => undefined);
    await reg.get("s", { mode: "incognito", profile: "p1" });
    expect(factory).toHaveBeenCalledWith("s", { mode: "incognito", profile: "p1" });
    // A second get() with a *different* spec must NOT re-create or re-spec.
    await reg.get("s", { mode: "persistent" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("close(default) allows lazy re-creation on the next get()", async () => {
    const factory = vi.fn(async (id: string) => fakeEntry(id));
    const reg = new SessionRegistry(factory, async () => undefined);
    await reg.get();                 // create default
    await reg.close(DEFAULT_SESSION_ID);
    await reg.get();                 // re-create
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
