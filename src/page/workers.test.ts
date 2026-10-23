// Unit coverage for the workers registry. The full end-to-end story (page-side
// Worker wrapper survives a real init-script injection; SW CDP auto-attach
// fires under a real browser) is driven by the keystone — here we cover the
// pieces that don't need a browser:
//
//   - `list` against a faked Page returns the page-side __browxWorkers list
//   - `sendMessage` routes ww-* to the page and sw-* through the CDP path
//   - `readMessages` drains the server-side SW ring (pre-seeded via
//     recordSwMessage)
//   - `addFetchIntercept` / `removeFetchIntercept` server-side bookkeeping
//   - `installPageWrapper` is idempotent (the in-page guard is what enforces
//     it at run-time; here we just prove we don't re-emit the init-script)

import { describe, it, expect, vi } from "vitest";
import { WorkersRegistry, WORKERS_PAGE_SCRIPT } from "./workers.js";

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
  it("drains the server-side SW ring for sw-* reads", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    reg.recordSwMessage("sw-1", "from-sw");
    f.enqueueResponse(() => undefined);
    const out = await reg.readMessages(f.page, { workerId: "sw-1" });
    expect(out).toHaveLength(1);
    expect(out[0]!.data).toBe("from-sw");
    expect(out[0]!.workerId).toBe("sw-1");
    // Re-read drains — second call sees nothing for sw-1.
    const again = await reg.readMessages(f.page, { workerId: "sw-1" });
    expect(again).toEqual([]);
  });

  it("trims SW payloads past the 4 KiB cap", () => {
    const reg = new WorkersRegistry();
    const huge = "x".repeat(8000);
    reg.recordSwMessage("sw-1", huge);

    const ring = (reg as any).swMessages as Array<{ data: string }>;
    expect(ring[0]!.data.length).toBeLessThan(huge.length);
    expect(ring[0]!.data.endsWith("…")).toBe(true);
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
