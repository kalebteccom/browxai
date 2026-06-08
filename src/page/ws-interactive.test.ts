// Unit coverage for the interactive WS primitives — the page-side wrapper is
// driven end-to-end by the keystone (it needs a real browser). Here we cover:
//   - the glob-to-regex matcher (server-side + page-side share intent)
//   - the per-session registry's send / addInterceptor / removeInterceptor
//     surface against a faked Playwright Page (records `evaluate` calls).

import { describe, it, expect, vi } from "vitest";
import { WsInteractiveRegistry, globToRegex, WS_PAGE_SCRIPT } from "./ws-interactive.js";

describe("globToRegex", () => {
  it("treats * as a single-segment wildcard", () => {
    const r = globToRegex("wss://x/*");
    expect(r.test("wss://x/foo")).toBe(true);
    expect(r.test("wss://x/foo/bar")).toBe(false); // single segment only
  });

  it("treats ** as any-character (including /)", () => {
    const r = globToRegex("wss://x/**");
    expect(r.test("wss://x/foo")).toBe(true);
    expect(r.test("wss://x/foo/bar/baz")).toBe(true);
  });

  it("escapes regex metacharacters in literal portions", () => {
    const r = globToRegex("wss://host.example/chat?room=1");
    expect(r.test("wss://host.example/chat?room=1")).toBe(true);
    expect(r.test("wssxhostxexample/chat?room=1")).toBe(false);
  });

  it("anchors both ends — a prefix mismatch fails even with **", () => {
    const r = globToRegex("wss://x/**");
    expect(r.test("not-wss://x/foo")).toBe(false);
    // `**` is intentionally greedy (.*), so trailing content is permitted —
    // that's the contract. Use a tighter pattern to forbid trailing content.
    const tight = globToRegex("wss://x/*");
    expect(tight.test("wss://x/foo extra")).toBe(true); // single-segment, no /
    expect(tight.test("wss://x/foo/bar")).toBe(false); // / forbids single
  });
});

// Minimal Page stub: records every `evaluate` call (arg + body) and a
// `context.addInitScript` call. Each test instantiates a fresh one.
function fakePage() {
  const evaluates: Array<{ arg: unknown; result: unknown }> = [];
  const initScripts: string[] = [];
  const handlers: Array<(arg: unknown) => unknown> = [];
  // Default behaviour for evaluate: invoke the recorded handler if any,
  // otherwise return `undefined`. Tests register a handler before calling
  // the registry method when they want a specific response.
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
    page: page as unknown as Parameters<WsInteractiveRegistry["send"]>[0],
    evaluates,
    initScripts,
    /** Queue a response for the next `evaluate` call. */
    enqueueResponse: (fn: (arg: unknown) => unknown) => handlers.push(fn),
  };
}

describe("WsInteractiveRegistry.install", () => {
  it("registers the page script as an init script (idempotent guard is in-page)", async () => {
    const reg = new WsInteractiveRegistry();
    const { page, initScripts } = fakePage();
    await reg.install(page);
    expect(initScripts).toHaveLength(1);
    expect(initScripts[0]).toContain("__browxWs");
    expect(initScripts[0]).toBe(WS_PAGE_SCRIPT);
  });

  it("also re-injects into the current document via evaluate (script source)", async () => {
    const reg = new WsInteractiveRegistry();
    const { page, evaluates } = fakePage();
    await reg.install(page);
    // One evaluate call for the re-injection.
    expect(evaluates).toHaveLength(1);
  });
});

describe("WsInteractiveRegistry.send", () => {
  it("ok path — forwards wsId on the result", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    // install does one evaluate; then send does one more.
    f.enqueueResponse(() => undefined); // install's re-inject
    f.enqueueResponse(() => ({ ok: true, url: "wss://x/socket", bytes: 5 }));
    const r = await reg.send(f.page, { wsId: "ws-1", message: "hello" });
    expect(r).toEqual({ ok: true, wsId: "ws-1", url: "wss://x/socket", bytes: 5 });
  });

  it("propagates the page-side ok:false (no such id)", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    f.enqueueResponse(() => undefined);
    f.enqueueResponse(() => ({ ok: false, error: "no socket with id ws-99" }));
    const r = await reg.send(f.page, { wsId: "ws-99", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no socket/);
    expect(r.wsId).toBe("ws-99");
  });
});

describe("WsInteractiveRegistry.addInterceptor", () => {
  it("records pattern + mode and surfaces it on list()", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    const r = await reg.addInterceptor(f.page, { pattern: "wss://x/**", response: "drop" });
    expect(r.key).toBe("wss://x/**");
    expect(r.active).toEqual(["wss://x/**"]);
    expect(reg.list()).toEqual(["wss://x/**"]);
  });

  it("encodes echo / drop / replace into the evaluate arg", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    await reg.addInterceptor(f.page, { pattern: "a", response: "drop" });
    await reg.addInterceptor(f.page, { pattern: "b", response: "echo" });
    await reg.addInterceptor(f.page, { pattern: "c", response: { data: "REPLACED" } });
    // first evaluate per addInterceptor is install's re-inject, second is the
    // intercept registration — so the intercept args land at odd indices.
    const dropArg = f.evaluates[1]!.arg as { pattern: string; mode: string; replacement: string | null };
    const echoArg = f.evaluates[3]!.arg as { pattern: string; mode: string; replacement: string | null };
    const replaceArg = f.evaluates[5]!.arg as { pattern: string; mode: string; replacement: string | null };
    expect(dropArg).toEqual({ pattern: "a", mode: "drop", replacement: null });
    expect(echoArg).toEqual({ pattern: "b", mode: "echo", replacement: null });
    expect(replaceArg).toEqual({ pattern: "c", mode: "replace", replacement: "REPLACED" });
  });

  it("re-adding the same pattern replaces the prior entry (no duplication)", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    await reg.addInterceptor(f.page, { pattern: "wss://x/**", response: "drop" });
    await reg.addInterceptor(f.page, { pattern: "wss://x/**", response: "echo" });
    expect(reg.list()).toEqual(["wss://x/**"]); // not duplicated
  });
});

describe("WsInteractiveRegistry.removeInterceptor", () => {
  it("removes one by pattern", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    await reg.addInterceptor(f.page, { pattern: "a", response: "drop" });
    await reg.addInterceptor(f.page, { pattern: "b", response: "drop" });
    const r = await reg.removeInterceptor(f.page, { pattern: "a" });
    expect(r.removed).toEqual(["a"]);
    expect(r.active).toEqual(["b"]);
  });

  it("with no pattern clears every interceptor", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    await reg.addInterceptor(f.page, { pattern: "a", response: "drop" });
    await reg.addInterceptor(f.page, { pattern: "b", response: "drop" });
    const r = await reg.removeInterceptor(f.page, {});
    expect(r.removed.sort()).toEqual(["a", "b"]);
    expect(r.active).toEqual([]);
  });

  it("removing an unknown pattern returns an empty removed list", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    const r = await reg.removeInterceptor(f.page, { pattern: "never-added" });
    expect(r.removed).toEqual([]);
  });
});

describe("WsInteractiveRegistry.listSockets", () => {
  it("returns the page-side __browxWs.list() result", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    f.enqueueResponse(() => [
      { wsId: "ws-1", url: "wss://x/socket", readyState: 1 },
      { wsId: "ws-2", url: "wss://y/socket", readyState: 0 },
    ]);
    const r = await reg.listSockets(f.page);
    expect(r).toEqual([
      { wsId: "ws-1", url: "wss://x/socket", readyState: 1 },
      { wsId: "ws-2", url: "wss://y/socket", readyState: 0 },
    ]);
  });

  it("does NOT install the wrapper (discovery is a passive read)", async () => {
    const reg = new WsInteractiveRegistry();
    const f = fakePage();
    f.enqueueResponse(() => []);
    await reg.listSockets(f.page);
    expect(f.initScripts).toHaveLength(0);
  });
});
