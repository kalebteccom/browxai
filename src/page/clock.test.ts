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
});

describe("ClockRegistry — rejections", () => {
  it.each([
    {
      name: "byMs on freeze",
      args: { mode: "freeze", byMs: 1000 },
      err: /byMs is only valid with mode:"advance"/,
    },
    {
      name: "an invalid atIso",
      args: { mode: "freeze", atIso: "not-a-date" },
      err: /atIso is not a valid ISO-8601 timestamp/,
    },
    {
      name: "advance with neither atIso nor byMs",
      args: { mode: "advance" },
      err: /advance requires either atIso or byMs/,
    },
    {
      name: "advance with both atIso and byMs",
      args: { mode: "advance", atIso: "2030-01-01T00:00:00Z", byMs: 1000 },
      err: /exactly one of atIso or byMs/,
    },
    { name: "byMs of 0", args: { mode: "advance", byMs: 0 }, err: /positive finite/ },
    { name: "a negative byMs", args: { mode: "advance", byMs: -1 }, err: /positive finite/ },
    { name: "a NaN byMs", args: { mode: "advance", byMs: Number.NaN }, err: /positive finite/ },
    {
      name: "byMs beyond the 1-year ceiling",
      args: { mode: "advance", byMs: 2 * 365 * 24 * 60 * 60 * 1000 },
      err: /exceeds max/,
    },
  ])("ClockRegistry rejects $name", async ({ args, err }) => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new ClockRegistry();
    await expect(reg.apply(cdp as never, page as never, args as never)).rejects.toThrow(err);
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
});
