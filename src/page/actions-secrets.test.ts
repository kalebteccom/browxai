// Dispatch-side scope check: a scoped alias is matched against the frame that
// receives the value, not the main frame's URL. Fakes stand in for the
// Playwright frame tree; only the members `materialiseValue` reads exist.

import { describe, it, expect } from "vitest";
import type { Locator } from "playwright-core";
import { fillChecked, materialiseValue, pressChecked } from "./actions-secrets.js";
import type { ActionContext } from "./action-context.js";
import { SecretRegistry } from "../util/secrets.js";

interface FakeFrame {
  url: () => string;
  locator: (sel: string) => unknown;
}

/** A frame whose focused child (if any) is `focusedChild`. */
function frame(url: string, focusedChild?: FakeFrame): FakeFrame {
  return {
    url: () => url,
    locator: () => ({
      count: async () => (focusedChild ? 1 : 0),
      first: () => ({
        elementHandle: async () => ({
          contentFrame: async () => focusedChild ?? null,
          dispose: async () => undefined,
        }),
      }),
    }),
  };
}

/** A locator whose element lives in a frame at `url`. */
function locatorIn(url: string): Locator {
  return {
    elementHandle: async () => ({
      ownerFrame: async () => ({ url: () => url }),
      dispose: async () => undefined,
    }),
  } as unknown as Locator;
}

function ctxAt(mainUrl: string, secrets: SecretRegistry, main?: FakeFrame): ActionContext {
  const mainFrame = main ?? frame(mainUrl);
  return {
    page: { url: () => mainUrl, mainFrame: () => mainFrame },
    secrets,
  } as unknown as ActionContext;
}

function scoped(): SecretRegistry {
  const r = new SecretRegistry();
  r.register({ name: "PASSWORD", value: "hunter2", scope: "app.example.com" });
  return r;
}

describe("materialiseValue: scope is checked against the receiving frame", () => {
  it("refuses a subframe on another origin even when the main frame matches", async () => {
    const ctx = ctxAt("https://app.example.com/login", scoped());
    const m = await materialiseValue(ctx, "<PASSWORD>", () =>
      locatorIn("https://widget.other.test/embed"),
    );
    expect(m.ok).toBe(false);
    expect(JSON.stringify(m)).not.toContain("hunter2");
    if (!m.ok) expect(m.error).toMatch(/https:\/\/widget\.other\.test/);
  });

  it("materialises into a scoped-origin iframe on another top-level page", async () => {
    const ctx = ctxAt("https://portal.other.test/", scoped());
    const m = await materialiseValue(ctx, "<PASSWORD>", () =>
      locatorIn("https://app.example.com/frame/login"),
    );
    expect(m).toMatchObject({ ok: true, value: "hunter2", alias: "PASSWORD" });
    if (m.ok) await m.bound?.dispose();
  });

  it("refuses an about:srcdoc frame, which has no origin a scope can name", async () => {
    const ctx = ctxAt("https://app.example.com/", scoped());
    const m = await materialiseValue(ctx, "<PASSWORD>", () => locatorIn("about:srcdoc"));
    expect(m.ok).toBe(false);
  });

  it("checks a targetless press against the focused frame", async () => {
    const child = frame("https://other.test/frame");
    const main = frame("https://app.example.com/", child);
    const ctx = ctxAt("https://app.example.com/", scoped(), main);
    const refused = await materialiseValue(ctx, "<PASSWORD>", "focused");
    expect(refused.ok).toBe(false);

    const ctxTop = ctxAt("https://app.example.com/", scoped());
    const ok = await materialiseValue(ctxTop, "<PASSWORD>", "focused");
    expect(ok.ok).toBe(true);
  });

  it("falls back to the main frame only when no frame is involved", async () => {
    expect(
      (await materialiseValue(ctxAt("https://app.example.com/", scoped()), "<PASSWORD>")).ok,
    ).toBe(true);
    expect((await materialiseValue(ctxAt("https://evil.test/", scoped()), "<PASSWORD>")).ok).toBe(
      false,
    );
  });

  it("reports an unresolvable target as a refusal, never a raw rejection", async () => {
    const ctx = ctxAt("https://app.example.com/", scoped());
    const broken = {
      elementHandle: async () => {
        throw new Error("Timeout 5000ms exceeded");
      },
    } as unknown as Locator;
    const m = await materialiseValue(ctx, "<PASSWORD>", () => broken);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error).toMatch(/could not be resolved/);
  });

  it("does not resolve any frame for an unscoped alias or a plain string", async () => {
    const r = new SecretRegistry();
    r.register({ name: "OTP", value: "123456" });
    const ctx = ctxAt("https://anywhere.test/", r);
    const never = (): Locator => {
      throw new Error("receiver must not be resolved");
    };
    expect(await materialiseValue(ctx, "<OTP>", never)).toEqual({
      ok: true,
      value: "123456",
      alias: "OTP",
    });
    expect(await materialiseValue(ctx, "typed", never)).toEqual({ ok: true, value: "typed" });
  });
});

/** An element handle whose owner frame URL is read from `state.url` on every
 *  call, so a test can move the frame between the check and the fill. */
function movableHandle(state: { url: string }): {
  handle: unknown;
  typed: string[];
  disposed: () => boolean;
} {
  const typed: string[] = [];
  let disposed = false;
  const handle = {
    ownerFrame: async () => ({ url: () => state.url }),
    fill: async (v: string) => {
      typed.push(v);
    },
    press: async (v: string) => {
      typed.push(v);
    },
    dispose: async () => {
      disposed = true;
    },
  };
  return { handle, typed, disposed: () => disposed };
}

/** A locator that must not be used for the dispatch of a scoped value. */
function locatorOver(handle: unknown, locTyped: string[] = []): Locator {
  return {
    elementHandle: async () => handle,
    fill: async (v: string) => {
      locTyped.push(v);
    },
    press: async (v: string) => {
      locTyped.push(v);
    },
  } as unknown as Locator;
}

describe("scoped dispatch goes through the checked element", () => {
  it("fills through the checked handle, not a fresh locator resolution", async () => {
    const state = { url: "https://app.example.com/login" };
    const h = movableHandle(state);
    const locTyped: string[] = [];
    const loc = locatorOver(h.handle, locTyped);
    const m = await materialiseValue(ctxAt(state.url, scoped()), "<PASSWORD>", () => loc);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    await fillChecked(loc, m, 1_000);
    expect(h.typed).toEqual(["hunter2"]);
    expect(locTyped).toEqual([]);
    await m.bound?.dispose();
    expect(h.disposed()).toBe(true);
  });

  it("refuses and types nothing when the frame moved off the scope after the check", async () => {
    const state = { url: "https://app.example.com/login" };
    const h = movableHandle(state);
    const locTyped: string[] = [];
    const loc = locatorOver(h.handle, locTyped);
    const m = await materialiseValue(ctxAt(state.url, scoped()), "<PASSWORD>", () => loc);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    state.url = "https://other.test/swapped";
    const err = await fillChecked(loc, m, 1_000).then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(err).toMatch(/other\.test/);
    expect(err).not.toContain("hunter2");
    expect(h.typed).toEqual([]);
    expect(locTyped).toEqual([]);
  });

  it("refuses a targeted press when the frame moved after the check", async () => {
    const state = { url: "https://app.example.com/login" };
    const h = movableHandle(state);
    const loc = locatorOver(h.handle);
    const ctx = ctxAt(state.url, scoped());
    const m = await materialiseValue(ctx, "<PASSWORD>", () => loc);
    if (!m.ok) throw new Error("expected materialisation");
    state.url = "https://other.test/";
    await expect(pressChecked(ctx.page, loc, m, 1_000)).rejects.toThrow(/other\.test/);
    expect(h.typed).toEqual([]);
  });

  it("re-checks the focused frame right before a targetless press", async () => {
    const pressed: string[] = [];
    const child = frame("https://other.test/frame");
    let focusMoved = false;
    const main: FakeFrame = {
      url: () => "https://app.example.com/",
      locator: (sel: string) => (focusMoved ? frame("", child) : frame("")).locator(sel),
    };
    const ctx = {
      page: {
        url: () => "https://app.example.com/",
        mainFrame: () => main,
        keyboard: {
          press: async (k: string) => {
            pressed.push(k);
          },
        },
      },
      secrets: scoped(),
    } as unknown as ActionContext;
    const m = await materialiseValue(ctx, "<PASSWORD>", "focused");
    if (!m.ok) throw new Error("expected materialisation");
    focusMoved = true;
    await expect(pressChecked(ctx.page, undefined, m, 1_000)).rejects.toThrow(/other\.test/);
    expect(pressed).toEqual([]);

    focusMoved = false;
    await pressChecked(ctx.page, undefined, m, 1_000);
    expect(pressed).toEqual(["hunter2"]);
  });

  it("leaves an unscoped value on the locator path", async () => {
    const r = new SecretRegistry();
    r.register({ name: "OTP", value: "123456" });
    const locTyped: string[] = [];
    const loc = locatorOver(undefined, locTyped);
    const m = await materialiseValue(ctxAt("https://anywhere.test/", r), "<OTP>", () => loc);
    if (!m.ok) throw new Error("expected materialisation");
    expect(m.bound).toBeUndefined();
    await fillChecked(loc, m, 1_000);
    expect(locTyped).toEqual(["123456"]);
  });
});
