import { describe, it, expect } from "vitest";
import type { Locator, Page } from "playwright-core";
import { RefRegistry } from "./refs.js";
import {
  verifyVisible,
  verifyText,
  verifyValue,
  verifyAttribute,
  verifyPredicate,
} from "./verify.js";
import { PlaywrightElementSubstrate } from "./element-substrate.js";
import { evaluatePredicate, type Predicate } from "../util/predicates.js";
import { evaluateExpect, type BatchExpect } from "../util/batch.js";

// Mocking strategy: each verify_* helper hits a single element through
// `ElementSubstrate`. The mock stays at the Playwright boundary — a Page whose
// locator/getByRole returns a mock Locator with the behaviour the test wants
// (count / isVisible / innerText / getAttribute / evaluate) — and the helpers are
// driven through the REAL `PlaywrightElementSubstrate` over it. So these cases
// cover the adapter's translation as well as the verify logic, which is what they
// have to: the port moved every read, and a test that mocked the port instead
// would be asserting the new code against itself.

interface MockLocatorBehaviour {
  count?: number;
  isVisible?: boolean;
  innerText?: string;
  attributes?: Record<string, string | null>;
  /** Result of `evaluate(fn, …)` for verify_value's DOM-side value read. */
  evaluatedValue?: string | null;
  /** Result of `evaluate(fn)` for verifyVisible's reason-probe. */
  notVisibleReason?: string;
}

function mockLocator(b: MockLocatorBehaviour): Locator {
  const self = {} as Locator;
  Object.assign(self, {
    first: () => self,
    count: async () => b.count ?? 1,
    isVisible: async () => b.isVisible ?? true,
    innerText: async () => b.innerText ?? "",
    getAttribute: async (name: string) => b.attributes?.[name] ?? null,
    evaluate: async (_fn: unknown) => {
      // If the caller asked for the DOM-side value (verifyValue), return it;
      // otherwise return the not-visible reason string (verifyVisible probe).
      if (b.evaluatedValue !== undefined) return b.evaluatedValue;
      return b.notVisibleReason ?? "hidden";
    },
  });
  return self;
}

function mockPage(locatorMap: Record<string, MockLocatorBehaviour>): Page {
  return {
    getByRole: (role: string, opts?: { name?: string }) => {
      const key = `role:${role}${opts?.name ? `[name=${opts.name}]` : ""}`;
      return mockLocator(locatorMap[key] ?? {});
    },
    locator: (selector: string) => {
      return mockLocator(locatorMap[selector] ?? {});
    },
  } as unknown as Page;
}

/** The real Playwright element adapter over the mock page. `frames` is never
 *  touched: no case here passes a frame scope, and the adapter resolves one only
 *  when asked for a scope that is not the main frame. */
function elementsOver(page: Page, refs: RefRegistry): PlaywrightElementSubstrate {
  return new PlaywrightElementSubstrate(() => page, {} as never, refs);
}

function refForButton(refs: RefRegistry, name = "Save"): string {
  return refs.forKey(`k-${name}`, { role: "button", name, source: "a11y" });
}

describe("verifyVisible", () => {
  it("fails source:'browxai' on coords target — verify family is structural", async () => {
    const refs = new RefRegistry();
    const page = mockPage({});
    const r = await verifyVisible(elementsOver(page, refs), { coords: { x: 0, y: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure?.source).toBe("browxai");
  });
});

describe("verifyText", () => {
  it.each([
    {
      name: "ok when innerText contains substring (default case-insensitive)",
      innerText: "  Saved successfully  ",
      expected: "saved",
      exact: false,
      result: { ok: true },
    },
    {
      name: "exact:true accepts case-sensitive equality on trimmed innerText",
      innerText: "  Saved  ",
      expected: "Saved",
      exact: true,
      result: { ok: true },
    },
    {
      name: "exact:true rejects a case-different match",
      innerText: "  Saved  ",
      expected: "saved",
      exact: true,
      result: { ok: false },
    },
    {
      name: "fails source:'app' with the actual snippet when text doesn't match",
      innerText: "Error: bad",
      expected: "Saved",
      exact: false,
      result: { ok: false, failure: { source: "app", actual: "Error: bad" } },
    },
  ])("$name", async ({ innerText, expected, exact, result }) => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Banner");
    const page = mockPage({ "role:button[name=Banner]": { count: 1, innerText } });
    const r = await verifyText(elementsOver(page, refs), { ref }, expected, exact);
    expect(r).toMatchObject(result);
  });
});

describe("verifyValue", () => {
  it.each([
    { name: "when value differs", evaluatedValue: "wrong", actual: "wrong" },
    {
      name: "with 'no value' for elements without a DOM value",
      evaluatedValue: null,
      actual: expect.stringContaining("no `value`"),
    },
  ])("fails source:'app' $name", async ({ evaluatedValue, actual }) => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Email");
    const page = mockPage({ "role:button[name=Email]": { count: 1, evaluatedValue } });
    const r = await verifyValue(elementsOver(page, refs), { ref }, "you@example.com");
    expect(r).toMatchObject({ ok: false, failure: { source: "app", actual } });
  });
});

describe("verifyAttribute", () => {
  it.each([
    {
      name: "fails source:'app' on attribute mismatch",
      attributes: { "aria-pressed": "false" },
      attribute: "aria-pressed",
      value: "true",
      result: { ok: false, failure: { actual: "false" } },
    },
    {
      name: "omitting `value` asserts presence, passing when the attribute is present",
      attributes: { "data-state": "open" },
      attribute: "data-state",
      value: undefined,
      result: { ok: true },
    },
    {
      name: "presence assertion fails when attribute is absent (getAttribute is null)",
      attributes: {},
      attribute: "data-state",
      value: undefined,
      result: { ok: false, failure: { actual: null } },
    },
  ])("$name", async ({ attributes, attribute, value, result }) => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Toggle");
    const page = mockPage({ "role:button[name=Toggle]": { count: 1, attributes } });
    const r = await verifyAttribute(elementsOver(page, refs), { ref }, attribute, value);
    expect(r).toMatchObject(result);
  });
});

describe("verifyPredicate — pure server-side eval", () => {
  // The full predicate-engine matrix lives in src/util/predicates.test.ts.
  // Here we verify the verify-family WRAPPER: failure shape, source
  // classification, predicate-shape rejection.

  const data = {
    actionResult: {
      element: { value: "hello world" },
      navigation: { kind: "spa" },
      console: { errors: [], warnings: 0 },
    },
  };

  it("fails source:'app' when the predicate doesn't hold over the data", () => {
    const r = verifyPredicate(
      { kind: "equals", key: "actionResult.element.value", value: "nope" },
      data,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure?.source).toBe("app");
      expect(r.failure?.kind).toBe("equals");
      expect(r.failure?.evidence?.["key"]).toBe("actionResult.element.value");
    }
  });

  it("fails source:'browxai' when predicate shape is malformed", () => {
    // missing `value` on an equals — caught by validatePredicate before eval.
    const r = verifyPredicate(
      { kind: "equals", key: "actionResult.element.value" } as unknown as Predicate,
      data,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure?.source).toBe("browxai");
      expect(r.failure?.kind).toBe("predicate-shape");
    }
  });

  // The key reason verify_predicate is NOT arbitrary JS: there is no
  // execution path for caller-supplied code, only data binding into a fixed
  // vocabulary. Regress that here by feeding shapes that LOOK like a JS
  // expression and confirming they error in validation, not in eval.
  it("does not interpret string `value` as code — JS-looking strings stay literal", () => {
    const r = verifyPredicate(
      { kind: "equals", key: "actionResult.element.value", value: "globalThis.foo()" },
      { actionResult: { element: { value: "globalThis.foo()" } } },
    );
    expect(r.ok).toBe(true); // literal string match — never evaluated as code
  });
});

describe("shared-vocabulary regression: batch.expect and verify_predicate share one engine", () => {
  // The invariant: `batch.expect` shorthands and `verify_predicate`
  // must speak the same primitives — one source of truth in
  // `src/util/predicates.ts`. The shorthand INPUT shape stays frozen
  // (back-compat with v0.1.0), but each shorthand lowers into a `Predicate`
  // and runs through the SAME `evaluatePredicate` engine `verifyPredicate`
  // uses. This block pins that equivalence: a fixed table of
  // (BatchExpect, matching Predicate) pairs is evaluated by BOTH
  // `evaluateExpect` (via the batch lowering path) AND `evaluatePredicate`
  // directly, against the same body, and the pass/fail decisions are
  // asserted identical. If the predicate engine ever changes — and the
  // shorthand lowering is not updated, or vice versa — this test fails.
  //
  // Edge cases covered: missing element, missing intermediate, null leaf,
  // case-sensitivity of `contains`, boolean equality.

  interface Case {
    name: string;
    body: unknown;
    expect: BatchExpect;
    predicate: Predicate;
  }

  const CASES: Case[] = [
    {
      name: "valueEquals hits",
      body: { element: { value: "hello" } },
      expect: { valueEquals: "hello" },
      predicate: { kind: "equals", key: "element.value", value: "hello" },
    },
    {
      name: "valueEquals misses",
      body: { element: { value: "other" } },
      expect: { valueEquals: "hello" },
      predicate: { kind: "equals", key: "element.value", value: "hello" },
    },
    {
      name: "valueEquals — missing element entirely",
      body: { something: "else" },
      expect: { valueEquals: "hello" },
      predicate: { kind: "equals", key: "element.value", value: "hello" },
    },
    {
      name: "valueEquals empty string against empty string",
      body: { element: { value: "" } },
      expect: { valueEquals: "" },
      predicate: { kind: "equals", key: "element.value", value: "" },
    },
    {
      name: "displayTextIncludes hits substring",
      body: { element: { displayText: "Engineering Team" } },
      expect: { displayTextIncludes: "Engineer" },
      predicate: { kind: "contains", key: "element.displayText", value: "Engineer" },
    },
    {
      name: "displayTextIncludes is case-sensitive (misses on case flip)",
      body: { element: { displayText: "Engineering" } },
      expect: { displayTextIncludes: "engineer" },
      predicate: { kind: "contains", key: "element.displayText", value: "engineer" },
    },
    {
      name: "displayTextIncludes — displayText is null (not string)",
      body: { element: { displayText: null } },
      expect: { displayTextIncludes: "x" },
      predicate: { kind: "contains", key: "element.displayText", value: "x" },
    },
    {
      name: "controlDisplayTextIncludes hits",
      body: { element: { ownerControl: { displayTextAfter: "Engineering" } } },
      expect: { controlDisplayTextIncludes: "Engineer" },
      predicate: {
        kind: "contains",
        key: "element.ownerControl.displayTextAfter",
        value: "Engineer",
      },
    },
    {
      name: "containerTextIncludes hits row text",
      body: { element: { container: { rowText: "row alpha beta gamma" } } },
      expect: { containerTextIncludes: "beta" },
      predicate: { kind: "contains", key: "element.container.rowText", value: "beta" },
    },
    {
      name: "controlChanged true hits",
      body: { element: { ownerControl: { changed: true } } },
      expect: { controlChanged: true },
      predicate: { kind: "equals", key: "element.ownerControl.changed", value: true },
    },
    {
      name: "controlChanged false hits when actually false",
      body: { element: { ownerControl: { changed: false } } },
      expect: { controlChanged: false },
      predicate: { kind: "equals", key: "element.ownerControl.changed", value: false },
    },
  ];

  for (const c of CASES) {
    it(`equivalence: ${c.name}`, () => {
      const expectResult = evaluateExpect(c.expect, c.body);
      const predResult = evaluatePredicate(c.predicate, c.body);
      const expectPassed = expectResult === null;
      const predPassed = predResult.ok;
      expect(expectPassed).toBe(predPassed);
    });
  }
});
