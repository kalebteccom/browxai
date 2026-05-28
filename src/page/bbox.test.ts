import { describe, it, expect, vi } from "vitest";
import { locatorBoundingBox } from "./bbox.js";

// Minimal Playwright Page/Locator fake — only the `.locator(s).first().boundingBox()`
// chain `locatorBoundingBox` touches.
function pageWith(boundingBox: () => Promise<unknown>) {
  return {
    locator: vi.fn(() => ({ first: () => ({ boundingBox }) })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("locatorBoundingBox — Playwright fallback for a bogus CDP null", () => {
  it("returns the rect when the locator has a real rendered box", async () => {
    const page = pageWith(async () => ({ x: 12, y: 34, width: 100, height: 20 }));
    expect(await locatorBoundingBox(page, "[data-testid=\"x\"]")).toEqual({
      x: 12, y: 34, width: 100, height: 20,
    });
  });

  it("returns null when Playwright reports no box (element not rendered)", async () => {
    const page = pageWith(async () => null);
    expect(await locatorBoundingBox(page, "#none")).toBeNull();
  });

  it("returns null for a zero-area box (collapsed / display:none-ish)", async () => {
    const page = pageWith(async () => ({ x: 0, y: 0, width: 0, height: 0 }));
    expect(await locatorBoundingBox(page, ".collapsed")).toBeNull();
  });

  it("swallows locator errors and returns null (best-effort)", async () => {
    const page = pageWith(async () => { throw new Error("strict mode violation"); });
    expect(await locatorBoundingBox(page, ".dupe")).toBeNull();
  });

  it("forwards opts.timeoutMs to Playwright's boundingBox — caps the auto-wait on a non-matching selector", async () => {
    // Without a cap, Playwright's `boundingBox()` blocks for 30 s on a
    // selector that resolves to no element (synthetic a11y refs like
    // `RootWebArea` are the recurring case). screenshot_marks's bare-ref
    // fallback path passes timeoutMs=1000 so the failure is fast.
    const bb = vi.fn(async () => null);
    const page = { locator: () => ({ first: () => ({ boundingBox: bb }) }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await locatorBoundingBox(page as any, "role=RootWebArea[name=\"x\"]", { timeoutMs: 1000 });
    expect(bb).toHaveBeenCalledWith({ timeout: 1000 });
    // Default (no opts) → 500 ms cap (the v0.2.1 perf-fix default).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await locatorBoundingBox(page as any, "#x");
    expect(bb).toHaveBeenLastCalledWith({ timeout: 500 });
    // timeoutMs: 0 → forwarded literally (Playwright treats 0 as "no timeout").
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await locatorBoundingBox(page as any, "#x", { timeoutMs: 0 });
    expect(bb).toHaveBeenLastCalledWith({ timeout: 0 });
  });
});
