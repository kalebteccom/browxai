import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import { locatorFor } from "./locator.js";
import { RefRegistry } from "./refs.js";

// Minimal Page mock. Each getByRole / locator call records its arguments and
// returns a sentinel "locator" carrying the invocation — enough to assert the
// routing path without spinning up a browser.
interface Recorded {
  method: "getByRole" | "locator";
  role?: string;
  options?: { name?: string };
  selector?: string;
}

function mockPage(): { page: Page; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const page = {
    getByRole: (role: string, options?: { name?: string }) => {
      calls.push({ method: "getByRole", role, options });
      return { first: () => ({ __routed: { method: "getByRole", role, options } }) };
    },
    locator: (selector: string) => {
      calls.push({ method: "locator", selector });
      return { first: () => ({ __routed: { method: "locator", selector } }) };
    },
  } as unknown as Page;
  return { page, calls };
}

describe("locatorFor — W-E5 provenance routing", () => {
  it("routes testId refs to the attribute-CSS form for any source", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", { role: "div", testId: "save-btn", testIdAttr: "data-testid", source: "dom" });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([{ method: "locator", selector: '[data-testid="save-btn"]' }]);
  });

  it("DOM-only refs without testId resolve via cssPath, not getByRole", () => {
    // The bug this primitive fixes: a DOM-walk-origin `<td>` ref without
    // role/name signal was being routed to getByRole("td"), which doesn't
    // match anything on most pages.
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", { role: "td", cssPath: "table > tbody > tr:nth-child(4) > td:nth-child(3)", source: "dom" });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([{ method: "locator", selector: "table > tbody > tr:nth-child(4) > td:nth-child(3)" }]);
  });

  it("a11y refs with role+name use getByRole({ name })", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", { role: "button", name: "Save", source: "a11y" });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([{ method: "getByRole", role: "button", options: { name: "Save" } }]);
  });

  it("'both' refs prefer getByRole({ name }) when a name is present", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", {
      role: "button",
      name: "Submit",
      cssPath: "form > button:nth-child(2)",
      source: "both",
    });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([{ method: "getByRole", role: "button", options: { name: "Submit" } }]);
  });

  it("'both' refs without a name fall back to cssPath before role-only", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", { role: "generic", cssPath: "main > div:nth-child(5)", source: "both" });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([{ method: "locator", selector: "main > div:nth-child(5)" }]);
  });

  it("falls back to role-only when nothing else is available", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", { role: "button", source: "a11y" });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([{ method: "getByRole", role: "button", options: undefined }]);
  });

  it("escapes testId values that contain quotes", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", { role: "div", testId: 'with "quotes"', testIdAttr: "data-testid", source: "dom" });
    locatorFor(page, refs, { ref });
    expect(calls[0]?.selector).toBe('[data-testid="with \\"quotes\\""]');
  });
});
