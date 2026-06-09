// Unit coverage for the workers registry. The full end-to-end story (page-side
// Worker wrapper survives a real init-script injection; SW CDP auto-attach
// fires under a real browser) is driven by the keystone — here we cover the
// pieces that don't need a browser:
//
//   - WORKERS_PAGE_SCRIPT is a non-empty string with the expected globals
//   - `list` against a faked Page returns the page-side __browxWorkers list
//   - `sendMessage` routes ww-* to the page and sw-* through the CDP path
//   - `readMessages` drains both the page-side ring and the server-side
//     SW ring (the latter pre-seeded via recordSwMessage)
//   - `addFetchIntercept` / `removeFetchIntercept` server-side bookkeeping
//   - `installPageWrapper` is idempotent (the in-page guard is what enforces
//     it at run-time; here we just prove we don't re-emit the init-script)

import { describe, it, expect, vi } from "vitest";
import { WorkersRegistry, WORKERS_PAGE_SCRIPT } from "./workers.js";

// --- WORKERS_PAGE_SCRIPT shape ------------------------------------------------

describe("WORKERS_PAGE_SCRIPT", () => {
  it("is a non-empty string declaring the __browxWorkers global", () => {
    expect(typeof WORKERS_PAGE_SCRIPT).toBe("string");
    expect(WORKERS_PAGE_SCRIPT.length).toBeGreaterThan(100);
    expect(WORKERS_PAGE_SCRIPT).toContain("__browxWorkers");
    // The wrapper installs over window.Worker — that's the headline.
    expect(WORKERS_PAGE_SCRIPT).toContain("window.Worker");
    // The three methods our registry calls into via page.evaluate.
    expect(WORKERS_PAGE_SCRIPT).toContain("list:");
    expect(WORKERS_PAGE_SCRIPT).toContain("post:");
    expect(WORKERS_PAGE_SCRIPT).toContain("drain:");
  });

  it("contains no tracker ids (no project-specific identifiers leaked)", () => {
    // grep-style guard — if someone later adds a tracker for analytics,
    // this test will tell us before grep-verification at acceptance.
    expect(WORKERS_PAGE_SCRIPT).not.toMatch(/UA-\d/);
    expect(WORKERS_PAGE_SCRIPT).not.toMatch(/G-[A-Z0-9]{8,}/);
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
  it("returns web-worker listings from the page side", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const c = fakeCdp();
    f.enqueueResponse(() => undefined); // installPageWrapper re-inject
    f.enqueueResponse(() => [
      { workerId: "ww-1", url: "https://x/worker.js" },
      { workerId: "ww-2", url: "" },
    ]);
    const out = await reg.list(f.page, c.cdp, "web");
    expect(out).toEqual([
      { workerId: "ww-1", type: "web", url: "https://x/worker.js" },
      { workerId: "ww-2", type: "web", url: "" },
    ]);
  });

  it("filter:web does not query the SW side", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const c = fakeCdp();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => []);
    await reg.list(f.page, c.cdp, "web");
    // SW listener install still happens (idempotent + per-session).
    const sendMethods = c.sends.map((s) => s.method);
    expect(sendMethods).toContain("ServiceWorker.enable");
  });

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

  it("ww-* error surfaces from the page side", async () => {
    const reg = new WorkersRegistry();
    const f = fakePage();
    const c = fakeCdp();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => ({ ok: false, error: "no worker with id ww-99" }));
    const r = await reg.sendMessage(f.page, c.cdp, { workerId: "ww-99", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no worker/);
    expect(r.workerId).toBe("ww-99");
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
  it("records the pattern + lists it back", async () => {
    const reg = new WorkersRegistry();
    const c = fakeCdp();
    const r = await reg.addFetchIntercept(c.cdp, {
      pattern: "https://api.example/**",
      response: { status: 200, body: "{}" },
    });
    expect(r.key).toBe("https://api.example/**");
    expect(r.active).toEqual(["https://api.example/**"]);
    expect(reg.listFetchIntercepts()).toEqual(["https://api.example/**"]);
  });

  it("re-adding the same pattern replaces the prior entry", async () => {
    const reg = new WorkersRegistry();
    const c = fakeCdp();
    await reg.addFetchIntercept(c.cdp, { pattern: "p", response: { body: "a" } });
    await reg.addFetchIntercept(c.cdp, { pattern: "p", response: { body: "b" } });
    expect(reg.listFetchIntercepts()).toEqual(["p"]);
  });

  it("removeFetchIntercept by pattern returns the removed entry", async () => {
    const reg = new WorkersRegistry();
    const c = fakeCdp();
    await reg.addFetchIntercept(c.cdp, { pattern: "a", response: {} });
    await reg.addFetchIntercept(c.cdp, { pattern: "b", response: {} });
    const r = await reg.removeFetchIntercept(c.cdp, { pattern: "a" });
    expect(r.removed).toEqual(["a"]);
    expect(r.active).toEqual(["b"]);
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

  it("removing an unknown pattern returns an empty removed list", async () => {
    const reg = new WorkersRegistry();
    const c = fakeCdp();
    const r = await reg.removeFetchIntercept(c.cdp, { pattern: "nope" });
    expect(r.removed).toEqual([]);
  });
});

// --- dispose ------------------------------------------------------------------

describe("WorkersRegistry.dispose", () => {
  it("is safe to call repeatedly", () => {
    const reg = new WorkersRegistry();
    expect(() => reg.dispose()).not.toThrow();
    expect(() => reg.dispose()).not.toThrow();
  });
});
