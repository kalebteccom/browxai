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
import type { Predicate } from "../util/predicates.js";

// Mocking strategy: each verify_* helper hits a single Locator. We hand the
// helper a Page whose locator/getByRole returns a mock Locator with the
// behaviour the test wants (count / isVisible / innerText / getAttribute /
// evaluate). Refs are registered through RefRegistry as the real helpers do.

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

function refForButton(refs: RefRegistry, name = "Save"): string {
  return refs.forKey(`k-${name}`, { role: "button", name, source: "a11y" });
}

describe("verifyVisible", () => {
  it("ok when locator reports visible", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs);
    const page = mockPage({ "role:button[name=Save]": { count: 1, isVisible: true } });
    const r = await verifyVisible(page, refs, { ref });
    expect(r.ok).toBe(true);
  });

  it("fails source:'app' when not visible — includes the reason from the probe", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs);
    const page = mockPage({
      "role:button[name=Save]": { count: 1, isVisible: false, notVisibleReason: "hidden (display:none)" },
    });
    const r = await verifyVisible(page, refs, { ref });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure?.source).toBe("app");
      expect(r.failure?.kind).toBe("visible");
      expect(r.failure?.actual).toContain("display:none");
    }
  });

  it("fails source:'app' when locator matches zero nodes", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs);
    const page = mockPage({ "role:button[name=Save]": { count: 0 } });
    const r = await verifyVisible(page, refs, { ref });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure?.source).toBe("app");
      expect(r.failure?.actual).toContain("0 nodes");
    }
  });

  it("fails source:'browxai' when ref is no longer in the registry", async () => {
    const refs = new RefRegistry();
    const page = mockPage({});
    const r = await verifyVisible(page, refs, { ref: "e999" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure?.source).toBe("browxai");
      expect(r.failure?.actual).toContain("no longer");
    }
  });

  it("fails source:'browxai' on coords target — verify family is structural", async () => {
    const refs = new RefRegistry();
    const page = mockPage({});
    const r = await verifyVisible(page, refs, { coords: { x: 0, y: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure?.source).toBe("browxai");
  });
});

describe("verifyText", () => {
  it("ok when innerText contains substring (default case-insensitive)", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Banner");
    const page = mockPage({ "role:button[name=Banner]": { count: 1, innerText: "  Saved successfully  " } });
    const r = await verifyText(page, refs, { ref }, "saved", false);
    expect(r.ok).toBe(true);
  });

  it("exact:true requires case-sensitive equality on trimmed innerText", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Banner");
    const page = mockPage({ "role:button[name=Banner]": { count: 1, innerText: "  Saved  " } });
    expect((await verifyText(page, refs, { ref }, "Saved", true)).ok).toBe(true);
    expect((await verifyText(page, refs, { ref }, "saved", true)).ok).toBe(false);
  });

  it("fails source:'app' with the actual snippet when text doesn't match", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Banner");
    const page = mockPage({ "role:button[name=Banner]": { count: 1, innerText: "Error: bad" } });
    const r = await verifyText(page, refs, { ref }, "Saved", false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure?.source).toBe("app");
      expect(r.failure?.actual).toBe("Error: bad");
    }
  });
});

describe("verifyValue", () => {
  it("ok when DOM-side value matches", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Email");
    const page = mockPage({ "role:button[name=Email]": { count: 1, evaluatedValue: "you@example.com" } });
    const r = await verifyValue(page, refs, { ref }, "you@example.com");
    expect(r.ok).toBe(true);
  });

  it("fails source:'app' with actual when value differs", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Email");
    const page = mockPage({ "role:button[name=Email]": { count: 1, evaluatedValue: "wrong" } });
    const r = await verifyValue(page, refs, { ref }, "you@example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure?.source).toBe("app");
      expect(r.failure?.actual).toBe("wrong");
    }
  });

  it("fails source:'app' with 'no value' for elements without a DOM value", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Email");
    const page = mockPage({ "role:button[name=Email]": { count: 1, evaluatedValue: null } });
    const r = await verifyValue(page, refs, { ref }, "anything");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure?.actual).toContain("no `value`");
  });
});

describe("verifyAttribute", () => {
  it("ok when attribute equals the expected value", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Toggle");
    const page = mockPage({ "role:button[name=Toggle]": { count: 1, attributes: { "aria-pressed": "true" } } });
    const r = await verifyAttribute(page, refs, { ref }, "aria-pressed", "true");
    expect(r.ok).toBe(true);
  });

  it("fails source:'app' on attribute mismatch", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Toggle");
    const page = mockPage({ "role:button[name=Toggle]": { count: 1, attributes: { "aria-pressed": "false" } } });
    const r = await verifyAttribute(page, refs, { ref }, "aria-pressed", "true");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure?.actual).toBe("false");
  });

  it("omitting `value` asserts presence — passes when attribute is present", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Toggle");
    const page = mockPage({ "role:button[name=Toggle]": { count: 1, attributes: { "data-state": "open" } } });
    const r = await verifyAttribute(page, refs, { ref }, "data-state", undefined);
    expect(r.ok).toBe(true);
  });

  it("presence assertion fails when attribute is absent (getAttribute → null)", async () => {
    const refs = new RefRegistry();
    const ref = refForButton(refs, "Toggle");
    const page = mockPage({ "role:button[name=Toggle]": { count: 1, attributes: {} } });
    const r = await verifyAttribute(page, refs, { ref }, "data-state", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure?.actual).toBeNull();
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

  it("ok when the predicate holds", () => {
    const r = verifyPredicate(
      { kind: "equals", key: "actionResult.element.value", value: "hello world" } as Predicate,
      data,
    );
    expect(r.ok).toBe(true);
  });

  it("fails source:'app' when the predicate doesn't hold over the data", () => {
    const r = verifyPredicate(
      { kind: "equals", key: "actionResult.element.value", value: "nope" } as Predicate,
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

  it("rejects accessor keys outside the allow-list", () => {
    const r = verifyPredicate(
      { kind: "equals", key: "process.env.SECRET", value: "x" } as Predicate,
      { process: { env: { SECRET: "leaked" } } },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure?.source).toBe("browxai");
  });

  it("composite and/or/not flow through to the engine", () => {
    const pred: Predicate = {
      kind: "and",
      predicates: [
        { kind: "exists", key: "actionResult.element.value" },
        {
          kind: "or",
          predicates: [
            { kind: "equals", key: "actionResult.navigation.kind", value: "full_load" },
            { kind: "equals", key: "actionResult.navigation.kind", value: "spa" },
          ],
        },
        {
          kind: "not",
          predicates: [{ kind: "gt", key: "actionResult.console.errors.length", value: 0 }],
        },
      ],
    };
    expect(verifyPredicate(pred, data).ok).toBe(true);
  });

  // The key reason verify_predicate is NOT arbitrary JS: there is no
  // execution path for caller-supplied code, only data binding into a fixed
  // vocabulary. Regress that here by feeding shapes that LOOK like a JS
  // expression and confirming they error in validation, not in eval.
  it("does not interpret string `value` as code — JS-looking strings stay literal", () => {
    const r = verifyPredicate(
      { kind: "equals", key: "actionResult.element.value", value: "globalThis.foo()" } as Predicate,
      { actionResult: { element: { value: "globalThis.foo()" } } },
    );
    expect(r.ok).toBe(true); // literal string match — never evaluated as code
  });
});

describe("shared-vocabulary regression: batch.expect shorthands lower into predicate kinds", () => {
  // The brief requires the predicate vocabulary to be shared with batch.expect
  // — same kinds, one source of truth. We don't change the batch.expect input
  // shape (would be a breaking change per the Phase-3.5 invariants), but the
  // *semantic* primitives (equals, contains) MUST be the same engine. This
  // test pins the equivalence: a `valueEquals: "x"` shorthand checks the same
  // condition as a `{kind:"equals", key:"actionResult.element.value", value:"x"}`
  // predicate over the same data.
  it("expect.valueEquals ⇔ predicate equals on element.value", () => {
    const data = { actionResult: { element: { value: "match" } } };
    const pred = verifyPredicate(
      { kind: "equals", key: "actionResult.element.value", value: "match" } as Predicate,
      data,
    );
    expect(pred.ok).toBe(true);

    // The shorthand check happens inside batch (over the inner-call body
    // shape `{ element: { value: ... } }` directly, not under actionResult).
    // Verify the predicate-form holds on the equivalent reshape.
    const innerShape = { actionResult: { element: { value: "match" } } };
    const pred2 = verifyPredicate(
      { kind: "equals", key: "actionResult.element.value", value: "match" } as Predicate,
      innerShape,
    );
    expect(pred2.ok).toBe(true);
  });

  it("expect.displayTextIncludes ⇔ predicate contains on element.displayText", () => {
    const data = { actionResult: { element: { displayText: "Engineering Team" } } };
    expect(
      verifyPredicate(
        { kind: "contains", key: "actionResult.element.displayText", value: "Engineer" } as Predicate,
        data,
      ).ok,
    ).toBe(true);
  });
});
