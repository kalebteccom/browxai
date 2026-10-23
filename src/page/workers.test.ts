// Unit coverage for the workers registry. The full end-to-end story (page-side
// Worker wrapper survives a real init-script injection; SW CDP auto-attach
// fires under a real browser) is driven by the keystone — here we cover the
// pieces that don't need a browser:
//
//   - `list` against a faked Page returns the page-side __browxWorkers list
//   - `sendMessage` routes ww-* to the page and sw-* through the CDP path
//   - `readMessages` drains the page-side Web Worker ring, and moves the
//     page-side service-worker ring (`drainSw`) into the server-side SW ring
//   - `addFetchIntercept` / `removeFetchIntercept` server-side bookkeeping
//   - `installPageWrapper` is idempotent (the in-page guard is what enforces
//     it at run-time; here we just prove we don't re-emit the init-script)

import { describe, it, expect, vi } from "vitest";
import { WorkersRegistry, WORKERS_PAGE_SCRIPT } from "./workers.js";

// --- WORKERS_PAGE_SCRIPT shape ------------------------------------------------

describe("WORKERS_PAGE_SCRIPT", () => {
  it("records service-worker messages from navigator.serviceWorker", () => {
    expect(WORKERS_PAGE_SCRIPT).toContain("navigator.serviceWorker");
    expect(WORKERS_PAGE_SCRIPT).toContain("drainSw:");
  });
});

// --- Page / CDP fakes ---------------------------------------------------------

function fakePage() {
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
  };
  const page = {
    context: () => ctx,
    evaluate,
  };
  return {
    page: page as unknown as Parameters<WorkersRegistry["list"]>[0],
    evaluates,
    initScripts,
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
    cdp: { send, on, off } as unknown as Parameters<WorkersRegistry["list"]>[1],
    sends,
    on,
    off,
  };
}

// --- installPageWrapper -------------------------------------------------------

describe("WorkersRegistry.installPageWrapper", () => {
  it("adds the init script once and re-injects into the current document", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    await reg.installPageWrapper(f.page);
    expect(f.initScripts).toHaveLength(1);
    expect(f.initScripts[0]).toBe(WORKERS_PAGE_SCRIPT);
    // One re-injection into the current page.
    expect(f.evaluates).toHaveLength(1);
  });

  it("is idempotent — a second install does not re-emit the script", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    await reg.installPageWrapper(f.page);
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
    const c = fakeCdp();
    // Seed a fake SW attachment server-side.

    (reg as any).swAttached.set("sess-A", {
      targetId: "tgt-A",
      sessionId: "sess-A",
      url: "https://x/sw.js",
      status: "running",
      fetchEnabled: false,
    });
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => [{ workerId: "ww-1", url: "https://x/w.js" }]);
    const out = await reg.list(f.page, c.cdp, "all");
    expect(out).toEqual([
      { workerId: "ww-1", type: "web", url: "https://x/w.js" },
      { workerId: "sw-1", type: "service", url: "https://x/sw.js", state: "running" },
    ]);
  });
});

// --- sendMessage --------------------------------------------------------------

describe("WorkersRegistry.sendMessage", () => {
  it("ww-* routes through the page-side __browxWorkers.post", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const c = fakeCdp();
    f.enqueueResponse(() => undefined); // installPageWrapper re-inject
    f.enqueueResponse(() => ({ ok: true }));
    const r = await reg.sendMessage(f.page, c.cdp, { workerId: "ww-1", message: "hello" });
    expect(r).toEqual({ ok: true, workerId: "ww-1" });
  });

  it("sw-* with no known SW returns an error", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const c = fakeCdp();
    const r = await reg.sendMessage(f.page, c.cdp, { workerId: "sw-1", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no service worker/);
  });

  it("rejects unknown workerId prefixes", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const c = fakeCdp();
    const r = await reg.sendMessage(f.page, c.cdp, { workerId: "garbage-7", message: "x" });
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

  it("a message and a CDP attachment of the same script URL share one sw-* id", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const c = fakeCdp();
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

    (reg as any).swAttached.set("sess-A", {
      targetId: "tgt-A",
      sessionId: "sess-A",
      url: "https://x/sw.js",
      status: "running",
      fetchEnabled: false,
    });
    const listed = await reg.list(f.page, c.cdp, "service");
    expect(listed).toEqual([
      { workerId: "sw-2", type: "service", url: "https://x/sw.js", state: "running" },
    ]);
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
