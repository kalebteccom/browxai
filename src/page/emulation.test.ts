import { describe, it, expect, vi } from "vitest";
import { EmulationRegistry, DEFAULT_NETWORK, DEFAULT_CPU } from "./emulation.js";

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
    /** test helper */
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

describe("EmulationRegistry — network_emulate", () => {
  it("applies offline + latency + bps to CDP via Network.emulateNetworkConditions", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    const { state, reset } = await reg.applyNetwork(cdp as never, page as never, {
      offline: false,
      latencyMs: 200,
      downloadBps: 1_500_000,
      uploadBps: 750_000,
    });
    expect(reset).toBe(false);
    expect(state).toEqual({
      offline: false,
      latencyMs: 200,
      downloadBps: 1_500_000,
      uploadBps: 750_000,
    });
    expect(calls).toEqual([
      {
        method: "Network.emulateNetworkConditions",
        params: {
          offline: false,
          latency: 200,
          downloadThroughput: 1_500_000,
          uploadThroughput: 750_000,
        },
      },
    ]);
  });

  it("offline:true forces offline mode", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    const { state } = await reg.applyNetwork(cdp as never, page as never, { offline: true });
    expect(state.offline).toBe(true);
    expect(calls[0]!.params.offline).toBe(true);
  });

  it("empty input resets — bps fields map to -1 for CDP", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    const { state, reset } = await reg.applyNetwork(cdp as never, page as never, {});
    expect(reset).toBe(true);
    expect(state).toEqual(DEFAULT_NETWORK);
    expect(calls[0]!.params).toEqual({
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });

  it("forwards packetLoss when within [0,1]", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    await reg.applyNetwork(cdp as never, page as never, { latencyMs: 50, packetLoss: 0.2 });
    expect(calls[0]!.params.packetLoss).toBe(0.2);
  });

  it("rejects packetLoss outside [0,1]", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    await expect(
      reg.applyNetwork(cdp as never, page as never, { packetLoss: 1.5 }),
    ).rejects.toThrow(/packetLoss/);
  });
});

describe("EmulationRegistry — cpu_emulate", () => {
  it("applies throttleRate via Emulation.setCPUThrottlingRate", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    const { state, reset } = await reg.applyCpu(cdp as never, page as never, { throttleRate: 4 });
    expect(reset).toBe(false);
    expect(state.throttleRate).toBe(4);
    expect(calls).toEqual([{ method: "Emulation.setCPUThrottlingRate", params: { rate: 4 } }]);
  });

  it("throttleRate:1 is the reset path", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    const { reset } = await reg.applyCpu(cdp as never, page as never, { throttleRate: 1 });
    expect(reset).toBe(true);
    expect(calls[0]!.params).toEqual({ rate: 1 });
  });

  it("empty input resets to 1", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    const { state, reset } = await reg.applyCpu(cdp as never, page as never, {});
    expect(reset).toBe(true);
    expect(state).toEqual(DEFAULT_CPU);
    expect(calls[0]!.params).toEqual({ rate: 1 });
  });

  it("rejects throttleRate < 1 or > 100", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    await expect(reg.applyCpu(cdp as never, page as never, { throttleRate: 0.5 })).rejects.toThrow(
      /throttleRate/,
    );
    await expect(reg.applyCpu(cdp as never, page as never, { throttleRate: 200 })).rejects.toThrow(
      /throttleRate/,
    );
  });
});

describe("EmulationRegistry — re-apply on navigation", () => {
  it("re-pushes the cached non-default state on main-frame framenavigated", async () => {
    const { cdp: cdp1, calls: calls1 } = fakeCdp();
    const { cdp: cdp2, calls: calls2 } = fakeCdp();
    const page = fakePage(cdp2);
    const reg = new EmulationRegistry();

    await reg.applyNetwork(cdp1 as never, page as never, { latencyMs: 300, downloadBps: 1000 });
    await reg.applyCpu(cdp1 as never, page as never, { throttleRate: 6 });

    // Sub-frame nav: ignored
    await (page as unknown as { _emit: (e: string, a: unknown) => Promise<void> })._emit(
      "framenavigated",
      frame(false),
    );
    expect(calls2).toHaveLength(0);

    // Main-frame nav: both overrides re-pushed onto the fresh CDP session
    await (page as unknown as { _emit: (e: string, a: unknown) => Promise<void> })._emit(
      "framenavigated",
      frame(true),
    );
    const methods = calls2.map((c) => c.method).sort();
    expect(methods).toEqual(["Emulation.setCPUThrottlingRate", "Network.emulateNetworkConditions"]);
    expect(calls1).toHaveLength(2); // original applies, untouched
  });

  it("does not re-apply if the cached state is the reset/default", async () => {
    const { cdp: cdp1 } = fakeCdp();
    const { cdp: cdp2, calls: calls2 } = fakeCdp();
    const page = fakePage(cdp2);
    const reg = new EmulationRegistry();

    await reg.applyNetwork(cdp1 as never, page as never, {});
    await reg.applyCpu(cdp1 as never, page as never, {});
    await (page as unknown as { _emit: (e: string, a: unknown) => Promise<void> })._emit(
      "framenavigated",
      frame(true),
    );
    expect(calls2).toHaveLength(0);
  });

  it("only installs the reattach hook once per page", async () => {
    const { cdp } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    await reg.applyNetwork(cdp as never, page as never, { latencyMs: 100 });
    await reg.applyNetwork(cdp as never, page as never, { latencyMs: 200 });
    await reg.applyCpu(cdp as never, page as never, { throttleRate: 2 });
    // page.on should have been called exactly once across all three apply calls
    expect(
      (page.on as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "framenavigated"),
    ).toHaveLength(1);
  });
});

describe("EmulationRegistry — composition + reset", () => {
  it("network_emulate is independent of cpu_emulate (compose freely)", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    await reg.applyNetwork(cdp as never, page as never, { latencyMs: 50 });
    await reg.applyCpu(cdp as never, page as never, { throttleRate: 4 });
    expect(reg.currentNetwork()?.latencyMs).toBe(50);
    expect(reg.currentCpu()?.throttleRate).toBe(4);
    expect(calls.map((c) => c.method)).toEqual([
      "Network.emulateNetworkConditions",
      "Emulation.setCPUThrottlingRate",
    ]);
  });

  it("resetAll clears both overrides via CDP", async () => {
    const { cdp, calls } = fakeCdp();
    const page = fakePage();
    const reg = new EmulationRegistry();
    await reg.applyNetwork(cdp as never, page as never, { latencyMs: 100 });
    await reg.applyCpu(cdp as never, page as never, { throttleRate: 4 });
    calls.length = 0;
    await reg.resetAll(cdp as never);
    expect(calls.map((c) => c.method).sort()).toEqual([
      "Emulation.setCPUThrottlingRate",
      "Network.emulateNetworkConditions",
    ]);
    expect(reg.currentNetwork()).toBeUndefined();
    expect(reg.currentCpu()).toBeUndefined();
  });
});
