import { describe, it, expect, vi } from "vitest";
import { ClockRegistry } from "./clock.js";

type CdpCall = { method: string; params: Record<string, unknown> };

function fakeCdp() {
  const calls: CdpCall[] = [];
  const cdp = {
    send: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    }),
  };
  return { cdp, calls };
}

function fakePage(cdpForNav?: ReturnType<typeof fakeCdp>["cdp"]) {
  const handlers: Record<string, Array<(arg: unknown) => unknown>> = {};
  const page = {
    on: vi.fn((event: string, h: (arg: unknown) => unknown) => {
      (handlers[event] ??= []).push(h);
    }),
    context: () => ({
      newCDPSession: async () => cdpForNav,
    }),
    _emit: async (event: string, arg: unknown): Promise<void> => {
      for (const h of handlers[event] ?? []) {
        await h(arg);
      }
    },
  };
  return page;
}

function frame(isMain = true) {
  return { parentFrame: () => (isMain ? null : {}) };
}

describe("ClockRegistry — freeze", () => {
  it("freezes virtual time at the supplied atIso via CDP", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    const { state, mode, appliedAtIso } = await reg.apply(cdp as never, page as never, {
      mode: "freeze",
      atIso: "2030-01-15T12:00:00.000Z",
    });
    expect(mode).toBe("freeze");
    expect(appliedAtIso).toBe("2030-01-15T12:00:00.000Z");
    expect(state).toEqual({ nowMs: Date.parse("2030-01-15T12:00:00.000Z"), paused: true });
    expect(calls).toEqual([
      {
        method: "Emulation.setVirtualTimePolicy",
        params: {
          policy: "pause",
          initialVirtualTime: Date.parse("2030-01-15T12:00:00.000Z") / 1000,
        },
      },
    ]);
  });

  it("freezes at wall-clock now when atIso omitted", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    const before = Date.now();
    const { state } = await reg.apply(cdp as never, page as never, { mode: "freeze" });
    const after = Date.now();
    expect(state!.nowMs).toBeGreaterThanOrEqual(before);
    expect(state!.nowMs).toBeLessThanOrEqual(after);
  });

  it("rejects byMs on freeze", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await expect(
      reg.apply(cdp as never, page as never, { mode: "freeze", byMs: 1000 }),
    ).rejects.toThrow(/byMs is only valid with mode:"advance"/);
  });

  it("rejects invalid atIso", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await expect(
      reg.apply(cdp as never, page as never, { mode: "freeze", atIso: "not-a-date" }),
    ).rejects.toThrow(/atIso is not a valid ISO-8601 timestamp/);
  });
});

describe("ClockRegistry — advance", () => {
  it("advances by byMs and re-pins via two pauses + an advance", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await reg.apply(cdp as never, page as never, {
      mode: "freeze",
      atIso: "2030-01-15T12:00:00.000Z",
    });
    calls.length = 0;
    const { state, mode, appliedAtIso } = await reg.apply(cdp as never, page as never, {
      mode: "advance",
      byMs: 60_000,
    });
    expect(mode).toBe("advance");
    expect(appliedAtIso).toBe("2030-01-15T12:01:00.000Z");
    expect(state!.nowMs).toBe(Date.parse("2030-01-15T12:01:00.000Z"));
    // Expected sequence: pause-at-current, advance(budget=60000), pause-at-target
    expect(calls.map((c) => c.params.policy)).toEqual(["pause", "advance", "pause"]);
    expect(calls[1]!.params.budget).toBe(60_000);
    expect(calls[2]!.params.initialVirtualTime).toBe(Date.parse("2030-01-15T12:01:00.000Z") / 1000);
  });

  it("advances to an absolute atIso", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await reg.apply(cdp as never, page as never, {
      mode: "freeze",
      atIso: "2030-01-15T12:00:00.000Z",
    });
    const { appliedAtIso, state } = await reg.apply(cdp as never, page as never, {
      mode: "advance",
      atIso: "2030-01-15T12:00:30.000Z",
    });
    expect(appliedAtIso).toBe("2030-01-15T12:00:30.000Z");
    expect(state!.nowMs).toBe(Date.parse("2030-01-15T12:00:30.000Z"));
  });

  it("rejects when neither atIso nor byMs given", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await expect(reg.apply(cdp as never, page as never, { mode: "advance" })).rejects.toThrow(
      /advance requires either atIso or byMs/,
    );
  });

  it("rejects when both atIso and byMs given", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await expect(
      reg.apply(cdp as never, page as never, {
        mode: "advance",
        atIso: "2030-01-01T00:00:00Z",
        byMs: 1000,
      }),
    ).rejects.toThrow(/exactly one of atIso or byMs/);
  });

  it("rejects byMs <= 0 or non-finite", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await expect(
      reg.apply(cdp as never, page as never, { mode: "advance", byMs: 0 }),
    ).rejects.toThrow(/positive finite/);
    await expect(
      reg.apply(cdp as never, page as never, { mode: "advance", byMs: -1 }),
    ).rejects.toThrow(/positive finite/);
    await expect(
      reg.apply(cdp as never, page as never, { mode: "advance", byMs: Number.NaN }),
    ).rejects.toThrow(/positive finite/);
  });

  it("rejects byMs exceeding the 1-year ceiling", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    const twoYears = 2 * 365 * 24 * 60 * 60 * 1000;
    await expect(
      reg.apply(cdp as never, page as never, { mode: "advance", byMs: twoYears }),
    ).rejects.toThrow(/exceeds max/);
  });
});

describe("ClockRegistry — release", () => {
  it("releases by issuing the `advance` policy with no budget", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await reg.apply(cdp as never, page as never, { mode: "freeze", atIso: "2030-01-01T00:00:00Z" });
    calls.length = 0;
    const { state, mode, appliedAtIso } = await reg.apply(cdp as never, page as never, {
      mode: "release",
    });
    expect(mode).toBe("release");
    expect(state).toBeUndefined();
    expect(appliedAtIso).toBeNull();
    expect(reg.current()).toBeUndefined();
    expect(calls).toEqual([
      { method: "Emulation.setVirtualTimePolicy", params: { policy: "advance" } },
    ]);
  });

  it("release on a never-set clock is harmless (no cached state)", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    const { state } = await reg.apply(cdp as never, page as never, { mode: "release" });
    expect(state).toBeUndefined();
    expect(reg.current()).toBeUndefined();
  });
});

describe("ClockRegistry — re-apply on navigation", () => {
  it("re-pushes the cached pause anchor on main-frame framenavigated", async () => {
    const { cdp: cdp1 } = fakeCdp();
    const { cdp: cdp2, calls: calls2 } = fakeCdp();
    const page = fakePage(cdp2);
    const reg = new ClockRegistry();

    await reg.apply(cdp1 as never, page as never, {
      mode: "freeze",
      atIso: "2030-01-15T12:00:00.000Z",
    });

    // Sub-frame nav: ignored
    await (page as unknown as { _emit: (e: string, a: unknown) => Promise<void> })._emit(
      "framenavigated",
      frame(false),
    );
    expect(calls2).toHaveLength(0);

    // Main-frame nav: pause re-issued onto the fresh CDP session
    await (page as unknown as { _emit: (e: string, a: unknown) => Promise<void> })._emit(
      "framenavigated",
      frame(true),
    );
    expect(calls2).toEqual([
      {
        method: "Emulation.setVirtualTimePolicy",
        params: {
          policy: "pause",
          initialVirtualTime: Date.parse("2030-01-15T12:00:00.000Z") / 1000,
        },
      },
    ]);
  });

  it("does not re-apply after release", async () => {
    const { cdp: cdp1 } = fakeCdp();
    const { cdp: cdp2, calls: calls2 } = fakeCdp();
    const page = fakePage(cdp2);
    const reg = new ClockRegistry();
    await reg.apply(cdp1 as never, page as never, {
      mode: "freeze",
      atIso: "2030-01-15T12:00:00.000Z",
    });
    await reg.apply(cdp1 as never, page as never, { mode: "release" });
    await (page as unknown as { _emit: (e: string, a: unknown) => Promise<void> })._emit(
      "framenavigated",
      frame(true),
    );
    expect(calls2).toHaveLength(0);
  });

  it("only installs the reattach hook once per page", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await reg.apply(cdp as never, page as never, {
      mode: "freeze",
      atIso: "2030-01-15T12:00:00.000Z",
    });
    await reg.apply(cdp as never, page as never, { mode: "advance", byMs: 1000 });
    await reg.apply(cdp as never, page as never, { mode: "release" });
    expect(
      (page.on as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "framenavigated"),
    ).toHaveLength(1);
  });
});

describe("ClockRegistry — state persistence + reset", () => {
  it("advance after freeze accumulates from the cached anchor, not wall-clock", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await reg.apply(cdp as never, page as never, {
      mode: "freeze",
      atIso: "2030-01-15T12:00:00.000Z",
    });
    await reg.apply(cdp as never, page as never, { mode: "advance", byMs: 5_000 });
    await reg.apply(cdp as never, page as never, { mode: "advance", byMs: 7_000 });
    expect(reg.current()!.nowMs).toBe(Date.parse("2030-01-15T12:00:12.000Z"));
  });

  it("resetAll clears the cached state via CDP", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await reg.apply(cdp as never, page as never, {
      mode: "freeze",
      atIso: "2030-01-15T12:00:00.000Z",
    });
    calls.length = 0;
    await reg.resetAll(cdp as never);
    expect(calls).toEqual([
      { method: "Emulation.setVirtualTimePolicy", params: { policy: "advance" } },
    ]);
    expect(reg.current()).toBeUndefined();
  });

  it("resetAll on a never-set clock is a no-op", async () => {
    const { cdp, calls } = fakeCdp();
    const reg = new ClockRegistry();
    await reg.resetAll(cdp as never);
    expect(calls).toHaveLength(0);
  });
});
