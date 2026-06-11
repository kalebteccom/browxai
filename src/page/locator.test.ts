import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import { locatorFor, resolveTarget, resolveTargetChecked } from "./locator.js";
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

describe("locatorFor — provenance routing", () => {
  it("routes testId refs to the attribute-CSS form for any source", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", {
      role: "div",
      testId: "save-btn",
      testIdAttr: "data-testid",
      source: "dom",
    });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([{ method: "locator", selector: '[data-testid="save-btn"]' }]);
  });

  it("DOM-only refs without testId resolve via cssPath, not getByRole", () => {
    // The bug this primitive fixes: a DOM-walk-origin `<td>` ref without
    // role/name signal was being routed to getByRole("td"), which doesn't
    // match anything on most pages.
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", {
      role: "td",
      cssPath: "table > tbody > tr:nth-child(4) > td:nth-child(3)",
      source: "dom",
    });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([
      { method: "locator", selector: "table > tbody > tr:nth-child(4) > td:nth-child(3)" },
    ]);
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
    const ref = refs.forKey("k1", {
      role: "generic",
      cssPath: "main > div:nth-child(5)",
      source: "both",
    });
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
    const ref = refs.forKey("k1", {
      role: "div",
      testId: 'with "quotes"',
      testIdAttr: "data-testid",
      source: "dom",
    });
    locatorFor(page, refs, { ref });
    expect(calls[0]?.selector).toBe('[data-testid="with \\"quotes\\""]');
  });
});

describe("locatorFor — frame-scoped refs", () => {
  it("routes a frame-bound ref through the bound Frame, NOT the page", () => {
    const { page, calls: pageCalls } = mockPage();
    const { page: framePage, calls: frameCalls } = mockPage();
    // Reuse the mockPage shape as a Frame surrogate — Page and Frame expose
    // the same locator/getByRole methods we touch from locatorFromInputs.
    const refs = new RefRegistry();
    const ref = refs.forKey("kf1", {
      role: "div",
      testId: "save-btn",
      testIdAttr: "data-testid",
      source: "dom",
      frameId: "f1",
    });

    refs.bindFrame(ref, framePage as any);
    locatorFor(page, refs, { ref });
    expect(pageCalls).toEqual([]);
    expect(frameCalls).toEqual([{ method: "locator", selector: '[data-testid="save-btn"]' }]);
  });

  it("main-frame ref (no binding) routes through the page — back-compat", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("kf1", {
      role: "div",
      testId: "save-btn",
      testIdAttr: "data-testid",
      source: "dom",
    });
    locatorFor(page, refs, { ref });
    expect(calls).toEqual([{ method: "locator", selector: '[data-testid="save-btn"]' }]);
  });

  it("contextRef-scoped selector resolves inside the bound frame's nested locator", () => {
    const { page, calls: pageCalls } = mockPage();
    const { page: framePage, calls: frameCalls } = mockPage();
    const refs = new RefRegistry();
    const ctx = refs.forKey("kfctx", {
      role: "main",
      cssPath: "main",
      source: "dom",
      frameId: "f2",
    });

    refs.bindFrame(ctx, framePage as any);
    locatorFor(page, refs, { selector: '[data-testid="x"]', contextRef: ctx });
    expect(pageCalls).toEqual([]);
    // First call: the contextRef itself was resolved on the frame (cssPath via locator).
    expect(frameCalls[0]).toEqual({ method: "locator", selector: "main" });
    // Then the scoped selector was applied inside that nested locator.
    expect(
      frameCalls.some((c) => c.scopedToCssPath === "main" && c.selector === '[data-testid="x"]'),
    ).toBe(true);
  });
});

describe("locatorFor — scoped selectors via contextRef", () => {
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
    expect(calls[0]).toEqual({
      method: "getByRole",
      role: "article",
      options: { name: "Order #42" },
    });
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
    expect(() => locatorFor(page, refs, { selector: ".x", contextRef: "e999" })).toThrow(
      /unknown contextRef/,
    );
  });
});

describe("resolveTarget — coords escape hatch", () => {
  it("returns kind:'coords' for coord targets without touching Page", () => {
    const { page, calls } = mockPage();
    const refs = new RefRegistry();
    const r = resolveTarget(page, refs, { coords: { x: 240, y: 120 } });
    expect(r.kind).toBe("coords");
    if (r.kind === "coords") {
      expect(r.x).toBe(240);
      expect(r.y).toBe(120);
    }
    expect(calls).toEqual([]); // no locator resolution attempted
  });

  it("returns kind:'locator' for ref/selector/contextRef targets", () => {
    const { page } = mockPage();
    const refs = new RefRegistry();
    const ref = refs.forKey("k1", { role: "button", name: "Save", source: "a11y" });
    const r = resolveTarget(page, refs, { ref });
    expect(r.kind).toBe("locator");
  });

  it("locatorFor throws if called with a coords target — callers must switch on kind", () => {
    const { page } = mockPage();
    const refs = new RefRegistry();
    expect(() => locatorFor(page, refs, { coords: { x: 0, y: 0 } })).toThrow(
      /coords target has no Locator/,
    );
  });
});

// Count-aware fake: each resolved node carries the selector it came from and a
// `count()` driven by a per-selector table, so we can exercise the ambiguity
// branch of resolveTargetChecked deterministically.
function countingPage(counts: Record<string, number>) {
  const node = (sel: string) => ({ __sel: sel, count: async () => counts[sel] ?? 1 });
  return {
    locator: (selector: string) => ({ first: () => node(selector) }),
    getByRole: (role: string) => ({ first: () => node(`role:${role}`) }),
  } as any;
}
const selOf = (loc: unknown) => (loc as { __sel: string }).__sel;

describe("resolveTargetChecked — ambiguity-aware acting path", () => {
  it("coords pass straight through, no count() probing", async () => {
    const refs = new RefRegistry();
    const { resolved, warning } = await resolveTargetChecked(countingPage({}), refs, {
      coords: { x: 1, y: 2 },
    });
    expect(resolved.kind).toBe("coords");
    expect(warning).toBeUndefined();
  });

  it("a ref with no cssPath is left on the primary locator (nothing to re-resolve to)", async () => {
    const refs = new RefRegistry();
    const ref = refs.forKey("k", {
      role: "button",
      testId: "go",
      testIdAttr: "data-testid",
      source: "a11y",
    });
    const { resolved, warning } = await resolveTargetChecked(
      countingPage({ '[data-testid="go"]': 9 }),
      refs,
      { ref },
    );
    expect(warning).toBeUndefined();
    expect(selOf((resolved as { loc: unknown }).loc)).toBe('[data-testid="go"]');
  });

  it("unique primary → primary used, no warning", async () => {
    const refs = new RefRegistry();
    const ref = refs.forKey("k", {
      role: "button",
      testId: "edit",
      testIdAttr: "data-testid",
      cssPath: "main > div:nth-child(3) > button",
      source: "both",
    });
    const { resolved, warning } = await resolveTargetChecked(
      countingPage({ '[data-testid="edit"]': 1 }),
      refs,
      { ref },
    );
    expect(warning).toBeUndefined();
    expect(selOf((resolved as { loc: unknown }).loc)).toBe('[data-testid="edit"]');
  });

  it("ambiguous primary + resolvable concrete → re-resolve to the concrete element, warn", async () => {
    const refs = new RefRegistry();
    const ref = refs.forKey("k", {
      role: "button",
      testId: "edit",
      testIdAttr: "data-testid",
      cssPath: "main > div:nth-child(7) > button.edit",
      source: "both",
    });
    const { resolved, warning } = await resolveTargetChecked(
      countingPage({
        '[data-testid="edit"]': 6,
        "main > div:nth-child(7) > button.edit": 1,
      }),
      refs,
      { ref },
    );
    expect(selOf((resolved as { loc: unknown }).loc)).toBe("main > div:nth-child(7) > button.edit");
    expect(warning).toMatch(/ambiguous/);
    expect(warning).toMatch(/Re-resolved to the concrete element/);
  });

  it("ambiguous primary + concrete no longer resolves → keep primary, warn to verify", async () => {
    const refs = new RefRegistry();
    const ref = refs.forKey("k", {
      role: "button",
      testId: "edit",
      testIdAttr: "data-testid",
      cssPath: "stale > path",
      source: "both",
    });
    const { resolved, warning } = await resolveTargetChecked(
      countingPage({ '[data-testid="edit"]': 4, "stale > path": 0 }),
      refs,
      { ref },
    );
    expect(selOf((resolved as { loc: unknown }).loc)).toBe('[data-testid="edit"]');
    expect(warning).toMatch(/no longer resolves/);
  });
});
