import { describe, it, expect, vi } from "vitest";
import { RouteRegistry } from "./routes.js";

function fakePage() {
  const registered: Array<{ url: string; handler: (r: unknown) => Promise<void> }> = [];
  const page = {
    route: vi.fn(async (url: string, handler: (r: unknown) => Promise<void>) => {
      registered.push({ url, handler });
    }),
    unroute: vi.fn(async () => undefined),
  };
  return { page, registered };
}

function fakeRoute(method = "GET") {
  return {
    request: () => ({ method: () => method }),
    fulfill: vi.fn(async () => undefined),
    fallback: vi.fn(async () => undefined),
  };
}

describe("RouteRegistry.add", () => {
  it("registers a page.route and fulfils a matching request", async () => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    const r = await reg.add(page as never, { urlPattern: "**/api/x", status: 201, body: "{}" });
    expect(r.key).toBe("* **/api/x");
    expect(reg.list()).toEqual(["* **/api/x"]);
    const route = fakeRoute("GET");
    await registered[0]!.handler(route);
    expect(route.fulfill).toHaveBeenCalledWith({
      status: 201,
      contentType: "application/json",
      body: "{}",
    });
  });

  it("falls through when the method doesn't match", async () => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/api/x", method: "POST", status: 200 });
    const route = fakeRoute("GET");
    await registered[0]!.handler(route);
    expect(route.fallback).toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
  });
});

describe("RouteRegistry.addQueue", () => {
  it("consumes one response per match, then falls through", async () => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    const r = await reg.addQueue(page as never, {
      urlPattern: "**/api/q",
      responses: [
        { status: 200, body: "first" },
        { status: 200, body: "second" },
      ],
    });
    expect(r.queued).toBe(2);
    const h = registered[0]!.handler;
    const r1 = fakeRoute();
    await h(r1);
    const r2 = fakeRoute();
    await h(r2);
    const r3 = fakeRoute();
    await h(r3);
    expect(r1.fulfill).toHaveBeenCalledWith(expect.objectContaining({ body: "first" }));
    expect(r2.fulfill).toHaveBeenCalledWith(expect.objectContaining({ body: "second" }));
    expect(r3.fallback).toHaveBeenCalled(); // queue exhausted
  });
});

describe("RouteRegistry.remove", () => {
  it("removes one route by pattern", async () => {
    const { page } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/a" });
    await reg.add(page as never, { urlPattern: "**/b" });
    const removed = await reg.remove(page as never, { urlPattern: "**/a" });
    expect(removed).toEqual(["* **/a"]);
    expect(reg.list()).toEqual(["* **/b"]);
    expect(page.unroute).toHaveBeenCalledTimes(1);
  });

  it("with no pattern clears every route", async () => {
    const { page } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/a" });
    await reg.add(page as never, { urlPattern: "**/b" });
    const removed = await reg.remove(page as never, {});
    expect(removed.sort()).toEqual(["* **/a", "* **/b"]);
    expect(reg.list()).toEqual([]);
  });

  it("re-adding the same key replaces the prior route", async () => {
    const { page } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/a", status: 200 });
    await reg.add(page as never, { urlPattern: "**/a", status: 500 });
    expect(reg.list()).toEqual(["* **/a"]); // not duplicated
    expect(page.unroute).toHaveBeenCalledTimes(1); // old one cleared
  });
});
