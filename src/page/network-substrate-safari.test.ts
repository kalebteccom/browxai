import { describe, it, expect } from "vitest";
import { SafariNoopNetworkSubstrate } from "./network-substrate.js";

// Safari has no network substrate at all (no CDP tap, no BiDi network domain).
// The no-op reports zero traffic + a structured network_body refusal. (The
// selector choosing it without touching page() is asserted in
// substrate-select-declaration.test.ts.)

describe("Safari network substrate (no-op, gated)", () => {
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
