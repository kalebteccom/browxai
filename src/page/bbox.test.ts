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
});
