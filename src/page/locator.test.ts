import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import { locatorFor } from "./locator.js";
import { RefRegistry } from "./refs.js";

// Minimal Page mock. Each getByRole / locator call records its arguments and
// returns a chainable sentinel that supports `first()`, `locator()`, and
// `getByRole()` so we can also assert the nested-locator routing used by
// scoped (contextRef) actions.
interface Recorded {
  method: "getByRole" | "locator";
  role?: string;
  options?: { name?: string };
  selector?: string;
  /** When set, the call was made on a nested Locator (contextRef path). */
  scopedToCssPath?: string;
}

interface MockNode {
  first(): MockNode;
  locator(selector: string): MockNode;
  getByRole(role: string, options?: { name?: string }): MockNode;
}

function mockPage(): { page: Page; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const makeNested = (scope: string): MockNode => ({
    first: () => makeNested(scope),
    locator: (selector: string) => {
      calls.push({ method: "locator", selector, scopedToCssPath: scope });
      return makeNested(scope);
    },
    getByRole: (role: string, options?: { name?: string }) => {
      calls.push({ method: "getByRole", role, options, scopedToCssPath: scope });
      return makeNested(scope);
    },
  });
  const page = {
    getByRole: (role: string, options?: { name?: string }) => {
      calls.push({ method: "getByRole", role, options });
      return { first: () => makeNested(`getByRole:${role}`) };
    },
    locator: (selector: string) => {
      calls.push({ method: "locator", selector });
      return { first: () => makeNested(selector) };
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

describe("locatorFor — W-E4 scoped selectors via contextRef", () => {
  it("resolves selector inside contextRef's locator (nested locator semantics)", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const rowRef = refs.forKey("k-row", {
      role: "row",
      cssPath: "table > tbody > tr:nth-child(4)",
      source: "dom",
    });
    locatorFor(page, refs, {
      selector: '[data-testid="row-action"]',
      contextRef: rowRef,
    });
    // First call: resolves the context ref via cssPath.
    expect(calls[0]).toEqual({ method: "locator", selector: "table > tbody > tr:nth-child(4)" });
    // Second call: resolves the selector *inside* the context locator.
    expect(calls[1]).toEqual({
      method: "locator",
      selector: '[data-testid="row-action"]',
      scopedToCssPath: "table > tbody > tr:nth-child(4)",
    });
  });

  it("scoped role=button[name=...] routes through getByRole on the context locator", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const cardRef = refs.forKey("k-card", { role: "article", name: "Order #42", source: "a11y" });
    locatorFor(page, refs, {
      selector: 'role=button[name="Cancel"]',
      contextRef: cardRef,
    });
    // First call: context ref via getByRole({name}).
    expect(calls[0]).toEqual({ method: "getByRole", role: "article", options: { name: "Order #42" } });
    // Second call: scoped getByRole on the context.
    expect(calls[1]).toEqual({
      method: "getByRole",
      role: "button",
      options: { name: "Cancel" },
      scopedToCssPath: "getByRole:article",
    });
  });

  it("throws when contextRef is unknown", () => {
    const { page } = mockPage();
    const refs = new RefRegistry();
    expect(() => locatorFor(page, refs, { selector: ".x", contextRef: "e999" }))
      .toThrow(/unknown contextRef/);
  });
});
