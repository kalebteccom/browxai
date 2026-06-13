import { describe, it, expect } from "vitest";
import { networkSubstrateFor } from "./network-substrate-select.js";
import { SafariNoopNetworkSubstrate } from "./network-substrate.js";

// Safari has no network substrate at all (no CDP tap, no BiDi network domain).
// The selector returns the empty no-op without ever touching page(), and the
// no-op reports zero traffic + a structured network_body refusal.

describe("Safari network substrate (no-op, gated)", () => {
  it("selector returns the no-op for safari without calling page()", () => {
    let pageCalled = false;
    const sub = networkSubstrateFor({
      engine: "safari",
      page: () => {
        pageCalled = true;
        throw new Error("safari-no-playwright-page");
      },
    });
    expect(sub).toBeInstanceOf(SafariNoopNetworkSubstrate);
    expect(pageCalled).toBe(false);
  });

  it("reports empty rings and a zero-traffic action tap", async () => {
    const sub = new SafariNoopNetworkSubstrate();
    await sub.attach();
    expect(sub.http.iter()).toEqual([]);
    expect(sub.http.recent().summary).toEqual({ total: 0, byType: {}, failed: 0 });
    expect(sub.ws.recent()).toEqual({ total: 0, frames: [] });
    expect(sub.ws.since(0)).toEqual([]);

    const tap = sub.openActionTap();
    await tap.open();
    expect(await tap.close()).toEqual({
      summary: { total: 0, byType: {}, failed: 0 },
      requests: [],
      mutations: [],
    });
  });

  it("network_body returns a structured not-available", async () => {
    const res = await new SafariNoopNetworkSubstrate().fetchBody();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not available on the safari engine/);
  });
});
