import { describe, it, expect } from "vitest";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import {
  CdpNetworkSubstrate,
  PlaywrightNetworkSubstrate,
  SafariNoopNetworkSubstrate,
  ROUTE_ENGINE_REFUSAL,
  type NetworkSubstrate,
} from "./network-substrate.js";

// `NetworkSubstrate.route` / `.unroute` — RFC 0009 P3's network widening.
//
// The three `route_*` handlers each held a `requirePage(e.session)` and drove a
// `RouteRegistry` that lived on the session entry. The registry moved into the
// substrate, so these cover the two things that move with it: the interception
// still lands on `page.route` with the same arguments on BOTH Playwright
// substrates, and the registry is now per-substrate state whose `active` list
// the result carries.

/** A `Page` stand-in that records `route` / `unroute`. Playwright's interception
 *  primitive is what both Playwright substrates call, so this is the whole
 *  surface either of them touches. */
function fakePage(): {
  page: Page;
  routed: string[];
  unrouted: string[];
} {
  const routed: string[] = [];
  const unrouted: string[] = [];
  const page = {
    route: async (pattern: string) => {
      routed.push(pattern);
    },
    unroute: async (pattern: string) => {
      unrouted.push(pattern);
    },
  } as unknown as Page;
  return { page, routed, unrouted };
}

/** The two Playwright-backed substrates, built over the same fake page. Both
 *  drive interception through `page.route`; only OBSERVATION differs between
 *  them (CDP tap vs context events), which is why the route behaviour has to be
 *  identical and why the bodies delegate to one shared pair of functions. */
function playwrightBacked(page: Page): Array<{ name: string; sub: NetworkSubstrate }> {
  const cdp = { on: () => undefined, send: async () => ({}) } as unknown as CDPSession;
  const context = { on: () => undefined } as unknown as BrowserContext;
  return [
    { name: "CdpNetworkSubstrate", sub: new CdpNetworkSubstrate(cdp, () => page) },
    {
      name: "PlaywrightNetworkSubstrate",
      sub: new PlaywrightNetworkSubstrate(context, page, "firefox"),
    },
  ];
}

describe("route / unroute on the Playwright-backed substrates", () => {
  it.each(playwrightBacked(fakePage().page).map((s) => s.name))(
    "[%s] installs a single canned route and reports the active list",
    async (name) => {
      const { page, routed } = fakePage();
      const sub = playwrightBacked(page).find((s) => s.name === name)!.sub;
      const r = await sub.route({ urlPattern: "**/api/records*", status: 201, body: "{}" });
      expect(r.kind).toBe("installed");
      if (r.kind !== "installed") throw new Error("expected installed");
      expect(r.key).toBe("* **/api/records*");
      expect(r.queued, "the single form reports no queue depth").toBeUndefined();
      expect(r.active).toEqual(["* **/api/records*"]);
      expect(routed).toEqual(["**/api/records*"]);
    },
  );

  it.each(playwrightBacked(fakePage().page).map((s) => s.name))(
    "[%s] installs a queue route and reports its depth",
    async (name) => {
      const { page } = fakePage();
      const sub = playwrightBacked(page).find((s) => s.name === name)!.sub;
      const r = await sub.route({
        urlPattern: "**/api/x",
        method: "POST",
        responses: [{ status: 200 }, { status: 500 }],
      });
      expect(r.kind).toBe("installed");
      if (r.kind !== "installed") throw new Error("expected installed");
      expect(r.key).toBe("POST **/api/x");
      expect(r.queued).toBe(2);
    },
  );

  it.each(playwrightBacked(fakePage().page).map((s) => s.name))(
    "[%s] removes one route by pattern and leaves the rest active",
    async (name) => {
      const { page, unrouted } = fakePage();
      const sub = playwrightBacked(page).find((s) => s.name === name)!.sub;
      await sub.route({ urlPattern: "**/a" });
      await sub.route({ urlPattern: "**/b" });
      const r = await sub.unroute({ urlPattern: "**/a" });
      expect(r.kind).toBe("removed");
      if (r.kind !== "removed") throw new Error("expected removed");
      expect(r.removed).toEqual(["* **/a"]);
      expect(r.active).toEqual(["* **/b"]);
      expect(unrouted).toEqual(["**/a"]);
    },
  );

  it.each(playwrightBacked(fakePage().page).map((s) => s.name))(
    "[%s] clears every route when no pattern is given",
    async (name) => {
      const { page } = fakePage();
      const sub = playwrightBacked(page).find((s) => s.name === name)!.sub;
      await sub.route({ urlPattern: "**/a" });
      await sub.route({ urlPattern: "**/b" });
      const r = await sub.unroute({});
      expect(r.kind).toBe("removed");
      if (r.kind !== "removed") throw new Error("expected removed");
      expect(r.removed.sort()).toEqual(["* **/a", "* **/b"]);
      expect(r.active).toEqual([]);
    },
  );

  it("keeps the interception registry per substrate, not per process", async () => {
    // The registry used to be a field on the session entry, one per session. It
    // is substrate state now, and a substrate is built once per session — so two
    // sessions must not see each other's routes. A module-level registry would
    // pass every case above and fail this one.
    const a = new CdpNetworkSubstrate({} as CDPSession, () => fakePage().page);
    const b = new CdpNetworkSubstrate({} as CDPSession, () => fakePage().page);
    await a.route({ urlPattern: "**/only-a" });
    const cleared = await b.unroute({});
    expect(cleared.kind === "removed" && cleared.removed).toEqual([]);
    const still = await a.unroute({});
    expect(still.kind === "removed" && still.removed).toEqual(["* **/only-a"]);
  });

  it("evaluates the page accessor per call, so a dead target rejects", async () => {
    const sub = new CdpNetworkSubstrate({} as CDPSession, () => {
      throw new Error("attach-target-gone");
    });
    let promise: unknown;
    expect(() => {
      promise = sub.route({ urlPattern: "**/x" });
    }).not.toThrow();
    await expect(promise).rejects.toThrow("attach-target-gone");
    await expect(sub.unroute({})).rejects.toThrow("attach-target-gone");
  });
});

describe("route / unroute on the Safari no-op substrate", () => {
  it("REFUSES rather than reporting an empty install", async () => {
    // The one network member where a zero-valued answer is worse than an error:
    // `{installed, active: []}` would tell an agent it had stubbed a backend it
    // had not, and every assertion after that would be against the real one.
    const sub = new SafariNoopNetworkSubstrate();
    for (const r of [await sub.route(), await sub.unroute()]) {
      expect(r.kind).toBe("refusal");
      if (r.kind !== "refusal") throw new Error("expected refusal");
      expect(r.engine).toBe("safari");
      expect(r.error).toMatch(/not supported on the "safari" engine/);
      expect(r.hint).toContain(ROUTE_ENGINE_REFUSAL);
    }
  });
});
