import { describe, it, expect, vi } from "vitest";
import { SessionRegistry, DEFAULT_SESSION_ID, type SessionEntry } from "./registry.js";
import { WedgeTracker } from "./wedge.js";
import { SessionMetrics } from "./metrics.js";
import { DialogPolicyState } from "./dialog.js";
import { PermissionPolicyState } from "./permission.js";
import { NotificationPolicyState } from "./notification.js";
import { FsPickerPolicyState } from "./fs-picker.js";
import { newEmulationState } from "./emulation.js";
import { DeviceEmulationState as WebDeviceEmulationState } from "./device-emu.js";
import { newHarRecorderState } from "../page/har.js";
import { newVideoRecorderState } from "../page/video.js";

// Fake entry — only the registry's own bookkeeping is under test here; the
// browser wiring is exercised by integration, not unit, tests.
function fakeEntry(id: string): SessionEntry {
  return {
    id,
    mode: "persistent",

    session: { close: vi.fn(async () => undefined) } as any,

    refs: { __tag: `refs-${id}` } as any,

    snapshotSubstrate: {} as any,

    networkSubstrate: {} as any,

    frames: {} as any,

    console: {} as any,

    network: {} as any,

    ws: {} as any,

    bridge: { detach: vi.fn(async () => undefined) } as any,

    recorder: {} as any,

    replay: {} as any,

    feedback: {} as any,

    clipboard: {} as any,

    wsInteractive: {} as any,

    workers: { dispose: () => undefined } as any,

    regions: {} as any,

    emulation: {} as any,

    clock: {} as any,

    seededRandom: {} as any,
    perf: {} as any,

    coverage: {} as any,
    wedge: new WedgeTracker(),
    metrics: new SessionMetrics(),
    dialog: new DialogPolicyState(),
    permission: new PermissionPolicyState(),
    notification: new NotificationPolicyState(),
    fsPicker: new FsPickerPolicyState(),
    deviceEmulation: newEmulationState(),
    webDeviceEmulation: new WebDeviceEmulationState(false),
    har: newHarRecorderState(),
    video: newVideoRecorderState(),

    secrets: {} as any,
    extensions: { loaded: [] },

    downloads: {} as any,

    artifacts: {} as any,
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
    const reg = new SessionRegistry(
      async (id) => fakeEntry(id),
      async () => undefined,
    );
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
      () =>
        new Promise<SessionEntry>((r) => {
          resolve = r;
        }),
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
    const reg = new SessionRegistry(
      async (id) => fakeEntry(id),
      async () => undefined,
    );
    await reg.get("x");
    await reg.get("y");
    expect((await reg.closeMatching({ all: true })).sort()).toEqual(["x", "y"]);
    expect(reg.list()).toHaveLength(0);
  });

  it("closeMatching({ idleMs }) reaps only stale sessions; get() touches activity", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-19T10:00:00Z"));
      const reg = new SessionRegistry(
        async (id) => fakeEntry(id),
        async () => undefined,
      );
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
      const reg = new SessionRegistry(
        async (id) => fakeEntry(id),
        async () => undefined,
      );
      await reg.get("a-1"); // matches prefix, will be idle
      await reg.get("b-1"); // idle but wrong prefix
      vi.setSystemTime(new Date("2026-05-19T10:10:00Z"));
      const closed = await reg.closeMatching({ prefix: "a-", idleMs: 60_000 });
      expect(closed).toEqual(["a-1"]);
      expect(reg.peek("b-1")?.id).toBe("b-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("peek() never creates; list() reflects live entries", async () => {
    const reg = new SessionRegistry(
      async (id) => fakeEntry(id),
      async () => undefined,
    );
    expect(reg.peek("nope")).toBeUndefined();
    await reg.get("one");
    await reg.get("two");
    expect(
      reg
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual(["one", "two"]);
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
    await reg.get(); // create default
    await reg.close(DEFAULT_SESSION_ID);
    await reg.get(); // re-create
    expect(factory).toHaveBeenCalledTimes(2);
  });

  describe("ask-human memory across close", () => {
    const withPolicies = (
      id: string,
      p: { perm?: string; notif?: string; pick?: string },
    ): SessionEntry => {
      const e = fakeEntry(id);
      e.permission = new PermissionPolicyState({ mode: (p.perm ?? "raise") as "raise" });
      e.notification = new NotificationPolicyState({ mode: (p.notif ?? "allow") as "allow" });
      e.fsPicker = new FsPickerPolicyState({ mode: (p.pick ?? "raise") as "raise" });
      return e;
    };

    it("records the ask-human policies a name held at close, and only those", async () => {
      const reg = new SessionRegistry(
        async (id) => withPolicies(id, { perm: "ask-human", notif: "allow" }),
        async () => undefined,
      );
      await reg.get("s");
      expect(reg.heldAskHuman("s")).toBeUndefined();
      await reg.close("s");
      expect(reg.heldAskHuman("s")).toEqual({ permission: { mode: "ask-human" } });
    });

    it("catches an ask-human per-key override under a different top-level mode", async () => {
      const reg = new SessionRegistry(
        async (id) => {
          const e = withPolicies(id, {});
          e.fsPicker = new FsPickerPolicyState({
            mode: "allow",
            perAPI: { showSaveFilePicker: "ask-human" },
          });
          return e;
        },
        async () => undefined,
      );
      await reg.get("s");
      await reg.closeMatching({ all: true });
      expect(reg.heldAskHuman("s")?.fsPicker?.perAPI?.showSaveFilePicker).toBe("ask-human");
    });

    it("a reopen inherits a policy the spec leaves out and keeps one it names", async () => {
      const factory = vi.fn(async (id: string) => withPolicies(id, { perm: "ask-human" }));
      const reg = new SessionRegistry(factory, async () => undefined);
      await reg.get("s");
      await reg.close("s");
      await reg.get("s", { notificationPolicy: { mode: "deny" } });
      expect(factory).toHaveBeenLastCalledWith("s", {
        permissionPolicy: { mode: "ask-human" },
        notificationPolicy: { mode: "deny" },
        fsPickerPolicy: undefined,
      });
    });

    it("a lazily re-created default session inherits the hold", async () => {
      const factory = vi.fn(async (id: string) => withPolicies(id, { notif: "ask-human" }));
      const reg = new SessionRegistry(factory, async () => undefined);
      await reg.get();
      await reg.close(DEFAULT_SESSION_ID);
      await reg.get();
      expect(factory).toHaveBeenLastCalledWith(
        "default",
        expect.objectContaining({ notificationPolicy: { mode: "ask-human" } }),
      );
    });

    it("a name that never held ask-human gets its spec untouched", async () => {
      const factory = vi.fn(async (id: string) => withPolicies(id, { perm: "allow" }));
      const reg = new SessionRegistry(factory, async () => undefined);
      await reg.get("s", { permissionPolicy: { mode: "allow" } });
      await reg.close("s");
      expect(reg.heldAskHuman("s")).toBeUndefined();
      await reg.get("s", { permissionPolicy: { mode: "allow" } });
      expect(factory).toHaveBeenLastCalledWith("s", { permissionPolicy: { mode: "allow" } });
    });

    it("a hold moved off ask-human before close is released", async () => {
      const reg = new SessionRegistry(
        async (id) => withPolicies(id, { perm: "ask-human" }),
        async () => undefined,
      );
      const e = await reg.get("s");
      e.permission.set({ mode: "allow" });
      await reg.close("s");
      expect(reg.heldAskHuman("s")).toBeUndefined();
    });
  });
});
