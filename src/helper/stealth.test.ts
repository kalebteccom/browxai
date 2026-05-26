import { describe, it, expect, vi } from "vitest";
import { applyStealth, buildStealthScript } from "./stealth.js";

describe("buildStealthScript", () => {
  it("includes the four well-known fingerprint patches", () => {
    const s = buildStealthScript();
    expect(s).toContain("navigator");
    expect(s).toContain("webdriver");
    expect(s).toContain("plugins");
    expect(s).toContain("languages");
    expect(s).toContain("chrome");
  });

  it("is wrapped in an IIFE — no globals leak into the page", () => {
    const s = buildStealthScript();
    expect(s.startsWith("(() => {")).toBe(true);
    expect(s.trimEnd().endsWith("})();")).toBe(true);
  });

  it("guards against double-apply via a sentinel on window", () => {
    const s = buildStealthScript();
    // sentinel name and the early-return must be present
    expect(s).toContain("__browx_stealth");
    expect(s).toMatch(/if \(window\.__browx_stealth\) return/);
  });

  it("uses configurable property descriptors (does not strand the patch)", () => {
    const s = buildStealthScript();
    // every defineProperty in the script must be configurable so a future
    // legitimate overwrite (or a re-apply with a different value) isn't
    // permanently locked out.
    const defineProps = s.match(/Object\.defineProperty\([^)]+\)/g) ?? [];
    expect(defineProps.length).toBeGreaterThanOrEqual(3);
    for (const dp of defineProps) {
      // each defineProperty appears in a block that has `configurable: true`
      // nearby — verify the script as a whole contains no non-configurable
      // patches (`configurable: false` would be a footgun).
      expect(dp).not.toContain("configurable: false");
    }
    expect(s).not.toContain("configurable: false");
  });

  it("evaluates without throwing in a node-like sandbox", () => {
    // Sanity: the IIFE compiles and runs against a synthetic
    // `window`/`navigator`. The actual patches operate on browser objects we
    // can't construct here — best we can do without Chromium.
    const navProto = Object.create(null);
    const win: Record<string, unknown> = { __navigator: navProto };
    const navigator: Record<string, unknown> = { languages: ["en-US"] };
    const ctx = { window: win, navigator };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function("window", "navigator", buildStealthScript());
    expect(() => fn(ctx.window, ctx.navigator)).not.toThrow();
  });
});

describe("applyStealth", () => {
  function fakeContext() {
    const pages = [{ evaluate: vi.fn(async () => undefined) }];
    return {
      addInitScript: vi.fn(async () => undefined),
      pages: () => pages,
      _pages: pages,
    };
  }

  it("registers the init script and re-applies it to already-open pages", async () => {
    const ctx = fakeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyStealth(ctx as any);
    expect(ctx.addInitScript).toHaveBeenCalledTimes(1);
    expect(ctx._pages[0]!.evaluate).toHaveBeenCalledTimes(1);
  });

  it("does not throw if a page evaluate fails (best-effort re-apply)", async () => {
    const ctx = fakeContext();
    ctx._pages[0]!.evaluate = vi.fn(async () => {
      throw new Error("page closed");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(applyStealth(ctx as any)).resolves.toBeUndefined();
  });
});
