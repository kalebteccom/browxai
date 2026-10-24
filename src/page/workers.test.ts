// Unit coverage for the workers registry. The full end-to-end story (page-side
// Worker wrapper survives a real init-script injection; a real service worker
// is listed and receives a message) is driven by the keystone — here we cover
// the pieces that don't need a browser:
//
//   - `list` against a faked Page returns the page-side __browxWorkers list,
//     plus the service workers the faked context holds
//   - `sendMessage` routes ww-* to the page and sw-* to `Worker.evaluate`, and
//     refuses sw-* naming the engine when it can't reach service workers
//   - `readMessages` drains the page-side Web Worker ring, and moves the
//     page-side service-worker ring (`drainSw`) into the server-side SW ring
//   - `addFetchIntercept` / `removeFetchIntercept` server-side bookkeeping
//   - `installPageWrapper` is idempotent (the in-page guard is what enforces
//     it at run-time; here we just prove we don't re-emit the init-script)

import { describe, it, expect, vi } from "vitest";
import { WorkersRegistry, WORKERS_PAGE_SCRIPT } from "./workers.js";
import { resolveOriginPolicy } from "../policy/origin.js";

// --- Page / CDP fakes ---------------------------------------------------------

/** A service-worker handle as Playwright's `context.serviceWorkers()` returns it. */
function fakeSw(url: string, evaluate?: (fn: unknown, arg: unknown) => unknown) {
  return {
    url: () => url,
    evaluate: vi.fn(async (fn: unknown, arg: unknown) => (evaluate ? evaluate(fn, arg) : true)),
  };
}

const CHROMIUM = { engine: "chromium", supported: true };
const FIREFOX = { engine: "firefox", supported: false };

function fakePage() {
  const serviceWorkers: Array<ReturnType<typeof fakeSw>> = [];
  const evaluates: Array<{ arg: unknown; result: unknown }> = [];
  const initScripts: string[] = [];
  const handlers: Array<(arg: unknown) => unknown> = [];
  const evaluate = vi.fn(async (_fn: unknown, arg?: unknown) => {
    const h = handlers.shift();
    const result = h ? h(arg) : undefined;
    evaluates.push({ arg, result });
    return result;
  });
  const ctx = {
    addInitScript: vi.fn(async ({ content }: { content: string }) => {
      initScripts.push(content);
    }),
    pages: () => [page],
    serviceWorkers: () => serviceWorkers,
  };
  const page = {
    context: () => ctx,
    evaluate,
  };
  return {
    page: page as unknown as Parameters<WorkersRegistry["list"]>[0],
    evaluates,
    initScripts,
    serviceWorkers,
    enqueueResponse: (fn: (arg: unknown) => unknown) => handlers.push(fn),
  };
}

function fakeCdp() {
  const sends: Array<{ method: string; params?: unknown }> = [];
  const send = vi.fn(async (method: string, params?: unknown) => {
    sends.push({ method, params });
    return undefined;
  });
  const on = vi.fn();
  const off = vi.fn();
  return {
    cdp: { send, on, off } as unknown as Parameters<WorkersRegistry["addFetchIntercept"]>[0],
    sends,
    on,
    off,
  };
}

// --- installPageWrapper -------------------------------------------------------

describe("WorkersRegistry.installPageWrapper", () => {
  it("adds the init script and re-injects once, and a second install does not re-emit it", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    await reg.installPageWrapper(f.page);
    expect(f.initScripts).toHaveLength(1);
    expect(f.initScripts[0]).toBe(WORKERS_PAGE_SCRIPT);
    // One re-injection into the current page.
    expect(f.evaluates).toHaveLength(1);
    await reg.installPageWrapper(f.page);
    expect(f.initScripts).toHaveLength(1);
    expect(f.evaluates).toHaveLength(1);
  });
});

// --- list ---------------------------------------------------------------------

describe("WorkersRegistry.list", () => {
  it("filter:all combines both halves", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.serviceWorkers.push(fakeSw("https://x/sw.js"));
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => [{ workerId: "ww-1", url: "https://x/w.js" }]);
    const out = await reg.list(f.page, CHROMIUM, "all");
    expect(out).toEqual([
      { workerId: "ww-1", type: "web", url: "https://x/w.js" },
      { workerId: "sw-1", type: "service", url: "https://x/sw.js", state: "running" },
    ]);
  });

  it("needs no CDP session: it reads the context's service workers", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.serviceWorkers.push(fakeSw("https://x/a.js"), fakeSw("https://x/b.js"));
    const out = await reg.list(f.page, CHROMIUM, "service");
    expect(out.map((w) => [w.workerId, w.url])).toEqual([
      ["sw-1", "https://x/a.js"],
      ["sw-2", "https://x/b.js"],
    ]);
  });

  it("lists two live workers of one script URL once", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.serviceWorkers.push(fakeSw("https://x/sw.js"), fakeSw("https://x/sw.js"));
    const out = await reg.list(f.page, CHROMIUM, "service");
    expect(out).toHaveLength(1);
  });

  it("filter:service on an engine without service workers refuses, naming the engine", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    await expect(reg.list(f.page, FIREFOX, "service")).rejects.toThrow(/"firefox" engine/);
  });

  it("filter:all on an engine without service workers still lists the Web Workers", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.serviceWorkers.push(fakeSw("https://x/sw.js"));
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => [{ workerId: "ww-1", url: "https://x/w.js" }]);
    const out = await reg.list(f.page, FIREFOX, "all");
    expect(out).toEqual([{ workerId: "ww-1", type: "web", url: "https://x/w.js" }]);
  });
});

// --- sendMessage --------------------------------------------------------------

describe("WorkersRegistry.sendMessage", () => {
  it("ww-* routes through the page-side __browxWorkers.post", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined); // installPageWrapper re-inject
    f.enqueueResponse(() => ({ ok: true }));
    const r = await reg.sendMessage(f.page, CHROMIUM, { workerId: "ww-1", message: "hello" });
    expect(r).toEqual({ ok: true, workerId: "ww-1" });
  });

  it("sw-* runs the dispatch function in the matching worker with the message", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const other = fakeSw("https://x/other.js");
    const target = fakeSw("https://x/sw.js");
    f.serviceWorkers.push(other, target);
    await reg.list(f.page, CHROMIUM, "service"); // other = sw-1, target = sw-2
    const r = await reg.sendMessage(f.page, CHROMIUM, { workerId: "sw-2", message: "hi" });
    expect(r).toEqual({ ok: true, workerId: "sw-2" });
    expect(other.evaluate).not.toHaveBeenCalled();
    expect(target.evaluate).toHaveBeenCalledTimes(1);
    const [fn, arg] = target.evaluate.mock.calls[0]!;
    expect(arg).toBe("hi");
    // The function is serialised into the worker, so it must stay self-contained
    // and dispatch a real `message` event.
    expect(String(fn)).toContain("MessageEvent");
    expect(String(fn)).toContain("dispatchEvent");
  });

  it("sw-* reports the evaluate failure", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.serviceWorkers.push(
      fakeSw("https://x/sw.js", () => {
        throw new Error("Target closed");
      }),
    );
    const r = await reg.sendMessage(f.page, CHROMIUM, { workerId: "sw-1", message: "x" });
    expect(r).toEqual({ ok: false, workerId: "sw-1", error: "Target closed" });
  });

  it("sw-* with no live SW returns an error", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const r = await reg.sendMessage(f.page, CHROMIUM, { workerId: "sw-1", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no service worker/);
  });

  it("sw-* on an engine without service workers is refused, naming the engine", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const sw = fakeSw("https://x/sw.js");
    f.serviceWorkers.push(sw);
    const r = await reg.sendMessage(f.page, FIREFOX, { workerId: "sw-1", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/"firefox" engine/);
    expect(sw.evaluate).not.toHaveBeenCalled();
  });

  it("rejects unknown workerId prefixes", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const r = await reg.sendMessage(f.page, CHROMIUM, { workerId: "garbage-7", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown workerId prefix/);
  });
});

// --- readMessages -------------------------------------------------------------

describe("WorkersRegistry.readMessages", () => {
  it("drains the page-side ring for Web Worker reads", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined); // installPageWrapper re-inject
    f.enqueueResponse(() => [
      { workerId: "ww-1", data: "hello", at: 1000 },
      { workerId: "ww-1", data: "world", at: 1001 },
    ]);
    const out = await reg.readMessages(f.page, { workerId: "ww-1" });
    expect(out).toEqual([
      { workerId: "ww-1", data: "hello", at: 1000 },
      { workerId: "ww-1", data: "world", at: 1001 },
    ]);
  });

  it("returns the messages a service worker posted to the page for sw-* reads", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined); // installPageWrapper re-inject
    f.enqueueResponse(() => [{ url: "https://x/sw.js", data: "from-sw", at: 42 }]); // drainSw
    const out = await reg.readMessages(f.page, { workerId: "sw-1" });
    expect(out).toEqual([{ workerId: "sw-1", data: "from-sw", at: 42 }]);
    // Re-read drains — the page ring is empty now, so nothing comes back.
    f.enqueueResponse(() => []);
    const again = await reg.readMessages(f.page, { workerId: "sw-1" });
    expect(again).toEqual([]);
  });

  it("an unfiltered read returns Web Worker and Service Worker messages together", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined); // installPageWrapper re-inject
    f.enqueueResponse(() => [{ workerId: "ww-1", data: "from-ww", at: 1 }]); // drain
    f.enqueueResponse(() => [{ url: "https://x/sw.js", data: "from-sw", at: 2 }]); // drainSw
    const out = await reg.readMessages(f.page, {});
    expect(out.map((m) => [m.workerId, m.data])).toEqual([
      ["ww-1", "from-ww"],
      ["sw-1", "from-sw"],
    ]);
  });

  it("keeps messages for other service workers when one id is read", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => [
      { url: "https://x/a.js", data: "a", at: 1 },
      { url: "https://x/b.js", data: "b", at: 2 },
    ]);
    const first = await reg.readMessages(f.page, { workerId: "sw-2" });
    expect(first.map((m) => m.data)).toEqual(["b"]);
    f.enqueueResponse(() => []);
    const rest = await reg.readMessages(f.page, { workerId: "sw-1" });
    expect(rest.map((m) => m.data)).toEqual(["a"]);
  });

  it("a message and a live service worker of the same script URL share one sw-* id", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => []); // drain (Web Workers)
    f.enqueueResponse(() => [
      { url: "https://x/other.js", data: "o", at: 1 },
      { url: "https://x/sw.js", data: "s", at: 2 },
    ]);
    const out = await reg.readMessages(f.page, {});
    expect(out.map((m) => [m.workerId, m.data])).toEqual([
      ["sw-1", "o"],
      ["sw-2", "s"],
    ]);

    f.serviceWorkers.push(fakeSw("https://x/sw.js"));
    const listed = await reg.list(f.page, CHROMIUM, "service");
    expect(listed).toEqual([
      { workerId: "sw-2", type: "service", url: "https://x/sw.js", state: "running" },
    ]);
  });

  it("lists a service worker the session saw live as stopped once it is gone", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => []); // drain (Web Workers)
    f.enqueueResponse(() => [{ url: "https://x/gone.js", data: "g", at: 1 }]);
    const gone = fakeSw("https://x/gone.js");
    f.serviceWorkers.push(gone);
    expect((await reg.list(f.page, CHROMIUM, "service")).map((w) => w.state)).toEqual(["running"]);
    f.serviceWorkers.length = 0;
    const read = await reg.readMessages(f.page, {});
    const listed = await reg.list(f.page, CHROMIUM, "service");
    for (const m of read) expect(listed.map((w) => w.workerId)).toContain(m.workerId);
    expect(listed.map((w) => [w.workerId, w.state])).toEqual([["sw-1", "stopped"]]);
  });

  it("does not list a service worker URL that only the page's message ring named", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => []); // drain (Web Workers)
    f.enqueueResponse(() => [
      { url: "https://planted.example/a.js", data: "a", at: 1 },
      { url: "https://planted.example/b.js", data: "b", at: 2 },
      { data: "no url", at: 3 },
    ]);
    const read = await reg.readMessages(f.page, {});
    expect(read).toHaveLength(3);
    expect(await reg.list(f.page, CHROMIUM, "service")).toEqual([]);
    // A real worker is listed as running, and the planted ids still are not.
    f.serviceWorkers.push(fakeSw("https://x/real.js"));
    const listed = await reg.list(f.page, CHROMIUM, "service");
    expect(listed.map((w) => [w.url, w.state])).toEqual([["https://x/real.js", "running"]]);
  });

  it("keeps a stopped service worker's id once it is listed, and does not message it", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const sw = fakeSw("https://x/sw.js");
    f.serviceWorkers.push(sw);
    expect((await reg.list(f.page, CHROMIUM, "service"))[0]!.state).toBe("running");
    f.serviceWorkers.length = 0;
    expect(await reg.list(f.page, CHROMIUM, "service")).toEqual([
      { workerId: "sw-1", type: "service", url: "https://x/sw.js", state: "stopped" },
    ]);
    const r = await reg.sendMessage(f.page, CHROMIUM, { workerId: "sw-1", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no service worker/);
    expect(sw.evaluate).not.toHaveBeenCalled();
  });

  it("lists at most 64 distinct service worker script URLs", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    for (let i = 0; i < 70; i++) f.serviceWorkers.push(fakeSw(`https://x/sw-${i}.js`));
    const listed = await reg.list(f.page, CHROMIUM, "service");
    expect(listed).toHaveLength(64);
    expect(listed[63]).toEqual({
      workerId: "sw-64",
      type: "service",
      url: "https://x/sw-63.js",
      state: "running",
    });
    // A worker past the cap has no id, so it cannot be messaged either.
    const r = await reg.sendMessage(f.page, CHROMIUM, { workerId: "sw-65", message: "x" });
    expect(r.ok).toBe(false);
  });

  it("trims SW payloads past the 4 KiB cap", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const huge = "x".repeat(8000);
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => [{ url: "https://x/sw.js", data: huge, at: 1 }]);
    const out = await reg.readMessages(f.page, { workerId: "sw-1" });
    expect(out[0]!.data.length).toBeLessThan(huge.length);
    expect(out[0]!.data.endsWith("…")).toBe(true);
  });

  it("ignores a malformed page ring and keeps only the newest 500 entries", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => "not-an-array");
    expect(await reg.readMessages(f.page, { workerId: "sw-1" })).toEqual([]);

    f.enqueueResponse(() => [
      null,
      42,
      ...Array.from({ length: 600 }, (_, i) => ({
        url: "https://x/sw.js",
        data: String(i),
        at: i,
      })),
    ]);
    const out = await reg.readMessages(f.page, { workerId: "sw-1" });
    expect(out).toHaveLength(500);
    expect(out[0]!.data).toBe("100");
    expect(out[499]!.data).toBe("599");
  });

  it("stops minting sw-* ids once a page names too many distinct script URLs", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => []); // drain (Web Workers)
    f.enqueueResponse(() =>
      Array.from({ length: 100 }, (_, i) => ({ url: `https://x/sw-${i}.js`, data: "d", at: i })),
    );
    const out = await reg.readMessages(f.page, {});
    expect(out).toHaveLength(64);
    expect(new Set(out.map((m) => m.workerId)).size).toBe(64);
  });
});

// --- addFetchIntercept / removeFetchIntercept ---------------------------------

describe("WorkersRegistry fetch intercepts", () => {
  it("re-adding the same pattern replaces the prior entry", async () => {
    const reg = new WorkersRegistry();
    const c = fakeCdp();
    await reg.addFetchIntercept(c.cdp, { pattern: "p", response: { body: "a" } });
    await reg.addFetchIntercept(c.cdp, { pattern: "p", response: { body: "b" } });
    expect(reg.listFetchIntercepts()).toEqual(["p"]);
  });

  it("removeFetchIntercept with no pattern clears every intercept", async () => {
    const reg = new WorkersRegistry();
    const c = fakeCdp();
    await reg.addFetchIntercept(c.cdp, { pattern: "a", response: {} });
    await reg.addFetchIntercept(c.cdp, { pattern: "b", response: {} });
    const r = await reg.removeFetchIntercept(c.cdp, {});
    expect(r.removed.sort()).toEqual(["a", "b"]);
    expect(r.active).toEqual([]);
  });
});

// --- origin policy ------------------------------------------------------------

describe("service workers and the origin policy", () => {
  const blocked = {
    ...CHROMIUM,
    originPolicy: resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "https://blocked.example" }),
  };

  it("omits a service worker on a blocked origin from the listing", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.serviceWorkers.push(
      fakeSw("https://blocked.example/sw.js"),
      fakeSw("https://ok.example/sw.js"),
    );
    const out = await reg.list(f.page, blocked, "service");
    expect(out).toEqual([
      { workerId: "sw-1", type: "service", url: "https://ok.example/sw.js", state: "running" },
    ]);
  });

  it("omits a service worker off the allowlist, like navigate does", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.serviceWorkers.push(
      fakeSw("https://ok.example/sw.js"),
      fakeSw("https://other.example/sw.js"),
    );
    const allowOnly = {
      ...CHROMIUM,
      originPolicy: resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: "https://ok.example" }),
    };
    const out = await reg.list(f.page, allowOnly, "service");
    expect(out.map((w) => w.url)).toEqual(["https://ok.example/sw.js"]);
  });

  it("returns no messages from a service worker the listing leaves out", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => []); // drain (Web Workers)
    f.enqueueResponse(() => [
      { url: "https://blocked.example/sw.js", data: "no", at: 1 },
      { url: "https://ok.example/sw.js", data: "yes", at: 2 },
    ]);
    const out = await reg.readMessages(f.page, {}, blocked);
    expect(out.map((m) => m.data)).toEqual(["yes"]);
    // Neither URL was seen running, so a ring message alone lists nothing.
    expect(await reg.list(f.page, blocked, "service")).toEqual([]);
    // Once both workers have run and stopped, the blocked origin stays out.
    f.serviceWorkers.push(
      fakeSw("https://blocked.example/sw.js"),
      fakeSw("https://ok.example/sw.js"),
    );
    expect((await reg.list(f.page, blocked, "service")).map((w) => w.url)).toEqual([
      "https://ok.example/sw.js",
    ]);
    f.serviceWorkers.length = 0;
    const listed = await reg.list(f.page, blocked, "service");
    expect(listed.map((w) => [w.url, w.state])).toEqual([["https://ok.example/sw.js", "stopped"]]);
  });

  it("refuses a send to a service worker on a blocked origin", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const sw = fakeSw("https://blocked.example/sw.js");
    f.serviceWorkers.push(sw);
    const r = await reg.sendMessage(f.page, blocked, { workerId: "sw-1", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^origin-blocked: /);
    expect(sw.evaluate).not.toHaveBeenCalled();
  });

  it("still messages a service worker on an allowed origin", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const sw = fakeSw("https://ok.example/sw.js");
    f.serviceWorkers.push(sw);
    const r = await reg.sendMessage(f.page, blocked, { workerId: "sw-1", message: "x" });
    expect(r).toEqual({ ok: true, workerId: "sw-1" });
    expect(sw.evaluate).toHaveBeenCalledTimes(1);
  });
});
