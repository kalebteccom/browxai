import { describe, it, expect, vi } from "vitest";
import { setTabVisibility } from "./visibility.js";

function driven() {
  return {
    evaluate: vi.fn(async () => undefined),
    bringToFront: vi.fn(async () => undefined),
    url: () => "http://app.test/",
  };
}
function scratch() {
  return {
    url: () => "about:blank",
    goto: vi.fn(async () => undefined),
    bringToFront: vi.fn(async () => undefined),
  };
}

describe("setTabVisibility", () => {
  it("foreground restores visibility and re-focuses the driven tab", async () => {
    const page = driven();
    const ctx = { pages: () => [page], newPage: vi.fn() };

    const r = await setTabVisibility(page as any, ctx as any, "foreground");
    expect(r).toMatchObject({ ok: true, state: "foreground", realBackgrounding: false });
    expect(page.evaluate).toHaveBeenCalledTimes(1); // SHOW
    expect(page.bringToFront).toHaveBeenCalledTimes(1);
    expect(ctx.newPage).not.toHaveBeenCalled();
  });

  it("background creates a scratch page, takes front focus, flips visibility", async () => {
    const page = driven();
    const sc = scratch();
    const ctx = { pages: () => [page], newPage: vi.fn(async () => sc) };

    const r = await setTabVisibility(page as any, ctx as any, "background");
    expect(r).toMatchObject({ ok: true, state: "background", realBackgrounding: true });
    expect(sc.bringToFront).toHaveBeenCalledTimes(1); // scratch took front
    expect(page.evaluate).toHaveBeenCalledTimes(1); // HIDE
    expect(r.note).toMatch(/backgrounded/);
  });

  it("background with holdMs auto-foregrounds after the hold and reports heldMs", async () => {
    const page = driven();
    const sc = scratch();
    const ctx = { pages: () => [page], newPage: vi.fn(async () => sc) };

    const r = await setTabVisibility(page as any, ctx as any, "background", 5);
    expect(r).toMatchObject({
      ok: true,
      state: "foreground",
      realBackgrounding: true,
      heldMs: 5,
    });
    // HIDE then SHOW
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.bringToFront).toHaveBeenCalledTimes(1); // re-focus on return
  });

  it("falls back to synthetic-only when no scratch page can be created", async () => {
    const page = driven();
    const ctx = {
      pages: () => [page],
      newPage: vi.fn(async () => {
        throw new Error("no new page");
      }),
    };

    const r = await setTabVisibility(page as any, ctx as any, "background");
    expect(r).toMatchObject({ ok: true, state: "background", realBackgrounding: false });
    expect(r.note).toMatch(/synthetic/);
  });

  it("reuses an existing about:blank scratch page instead of spawning another", async () => {
    const page = driven();
    const sc = scratch();
    const ctx = { pages: () => [page, sc], newPage: vi.fn() };

    const r = await setTabVisibility(page as any, ctx as any, "background");
    expect(r.realBackgrounding).toBe(true);
    expect(ctx.newPage).not.toHaveBeenCalled();
    expect(sc.bringToFront).toHaveBeenCalledTimes(1);
  });
});
