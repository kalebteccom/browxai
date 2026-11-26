import { describe, it, expect, vi } from "vitest";
import { RouteRegistry, installRoute, removeRoute } from "./routes.js";

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

function fakeRoute(method = "GET", resourceType = "fetch") {
  return {
    request: () => ({ method: () => method, resourceType: () => resourceType }),
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
  it("with no pattern clears every route", async () => {
    const { page } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/a" });
    await reg.add(page as never, { urlPattern: "**/b" });
    const { removed } = await reg.remove(page as never, {});
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

const DATA_TYPES = [
  "xhr",
  "fetch",
  "eventsource",
  "image",
  "media",
  "font",
  "stylesheet",
  "texttrack",
  "manifest",
];
// `other` is what a browser reports for a request it does not classify; a
// worker script arrives as `script` or `other` depending on the engine.
const RUN_TYPES = ["document", "script", "other", "websocket", "ping"];

describe("which resource types a route answers", () => {
  it.each(DATA_TYPES)("answers a %s request", async (type) => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/x", body: "{}" });
    const route = fakeRoute("GET", type);
    await registered[0]!.handler(route);
    expect(route.fulfill).toHaveBeenCalledTimes(1);
    expect(route.fallback).not.toHaveBeenCalled();
  });

  it.each(RUN_TYPES)("leaves a %s request to the network", async (type) => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/x", body: "{}" });
    const route = fakeRoute("GET", type);
    await registered[0]!.handler(route);
    expect(route.fallback).toHaveBeenCalledTimes(1);
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it.each(RUN_TYPES)("answers a %s request when the spec allows it", async (type) => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/x", body: "x", allowExecutable: true });
    const route = fakeRoute("GET", type);
    await registered[0]!.handler(route);
    expect(route.fulfill).toHaveBeenCalledTimes(1);
  });

  it("a queue consumes no entry on a request it leaves to the network", async () => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    await reg.addQueue(page as never, {
      urlPattern: "**/q",
      responses: [{ body: "first" }, { body: "second" }],
    });
    const h = registered[0]!.handler;
    const script = fakeRoute("GET", "script");
    await h(script);
    const doc = fakeRoute("GET", "document");
    await h(doc);
    const first = fakeRoute("GET", "fetch");
    await h(first);
    const second = fakeRoute("GET", "xhr");
    await h(second);
    expect(script.fallback).toHaveBeenCalled();
    expect(doc.fallback).toHaveBeenCalled();
    expect(first.fulfill).toHaveBeenCalledWith(expect.objectContaining({ body: "first" }));
    expect(second.fulfill).toHaveBeenCalledWith(expect.objectContaining({ body: "second" }));
  });

  it("a method mismatch is not counted as a skipped request", async () => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    await reg.add(page as never, { urlPattern: "**/x", method: "POST" });
    await registered[0]!.handler(fakeRoute("GET", "document"));
    expect(await reg.remove(page as never, {})).toEqual({
      removed: ["POST **/x"],
      skippedExecutable: 0,
    });
  });
});

describe("the skipped-request count", () => {
  it("is reported by installRoute when it replaces a route, and by removeRoute", async () => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    const first = await installRoute(reg, page as never, { urlPattern: "**/a" });
    expect(first).toEqual({
      kind: "installed",
      key: "* **/a",
      fulfils: "data",
      active: ["* **/a"],
    });
    await registered[0]!.handler(fakeRoute("GET", "script"));
    await registered[0]!.handler(fakeRoute("GET", "document"));

    const replaced = await installRoute(reg, page as never, {
      urlPattern: "**/a",
      responses: [{ body: "x" }],
    });
    expect(replaced).toEqual({
      kind: "installed",
      key: "* **/a",
      queued: 1,
      fulfils: "data",
      skippedExecutable: 2,
      active: ["* **/a"],
    });

    await installRoute(reg, page as never, { urlPattern: "**/b" });
    await registered[1]!.handler(fakeRoute("GET", "script"));
    await registered[2]!.handler(fakeRoute("GET", "other"));
    await registered[2]!.handler(fakeRoute("GET", "fetch"));
    expect(await removeRoute(reg, page as never, {})).toEqual({
      kind: "removed",
      removed: ["* **/a", "* **/b"],
      skippedExecutable: 2,
      active: [],
    });
  });

  it("is absent when nothing was skipped, and fulfils is all with allowExecutable", async () => {
    const { page, registered } = fakePage();
    const reg = new RouteRegistry();
    const r = await installRoute(reg, page as never, { urlPattern: "**/a", allowExecutable: true });
    expect(r).toEqual({ kind: "installed", key: "* **/a", fulfils: "all", active: ["* **/a"] });
    await registered[0]!.handler(fakeRoute("GET", "script"));
    expect(await removeRoute(reg, page as never, { urlPattern: "**/a" })).toEqual({
      kind: "removed",
      removed: ["* **/a"],
      active: [],
    });
  });
});
