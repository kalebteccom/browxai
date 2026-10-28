import { describe, it, expect, vi } from "vitest";
import { buildOverlayHideScript, applyOverlayHide } from "./overlay-hide.js";

describe("buildOverlayHideScript", () => {
  it("embeds selectors as JSON literals (no expression interpolation)", () => {
    const s = buildOverlayHideScript(["#hmr", ".cookie-banner"]);
    expect(s).toContain('["#hmr",".cookie-banner"]');
    expect(s).toContain("pointer-events:none !important;display:none !important;");
    // written via textContent — not HTML-parsed, can't escape <style>
    expect(s).toContain("st.textContent = css");
  });

  it("a hostile selector is JSON-escaped, not executable code", () => {
    const payload = '"];alert(1);//';
    const s = buildOverlayHideScript([payload]);
    // the only place the selector appears is inside the JSON array literal,
    // with the quote backslash-escaped — it cannot break out of the string.
    expect(s).toContain(JSON.stringify([payload]));
    expect(s).toContain('\\"];alert(1);//');
  });
});

describe("applyOverlayHide", () => {
  function fakeContext() {
    const pages = [{ evaluate: vi.fn(async () => undefined) }];
    return {
      addInitScript: vi.fn(async () => undefined),
      pages: () => pages,
      _pages: pages,
    };
  }

  it.each<[string, string[], number]>([
    ["no-ops on an empty selector list (feature off)", [], 0],
    ["registers the init script and re-applies to already-open pages", ["#hmr"], 1],
  ])("%s", async (_label, selectors, calls) => {
    const ctx = fakeContext();

    await applyOverlayHide(ctx as any, selectors);
    expect(ctx.addInitScript).toHaveBeenCalledTimes(calls);
    expect(ctx._pages[0]!.evaluate).toHaveBeenCalledTimes(calls);
  });
});
