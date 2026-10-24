import { describe, it, expect } from "vitest";
import { RefRegistry, type RefLocatorInputs } from "./refs.js";
import { generateLocator, generatePlaywrightLocator } from "./generate-locator.js";

describe("generatePlaywrightLocator — tier mapping", () => {
  it.each([
    {
      name: "tier 1: default data-testid lowers to getByTestId",
      input: { role: "button", testId: "save-btn", testIdAttr: "data-testid", source: "dom" },
      playwright: "page.getByTestId('save-btn')",
      stability: "high",
      components: [{ kind: "testid", value: "save-btn" }],
    },
    {
      // `getByTestId` is locked to `data-testid`, so a configured attribute
      // (BROWX_TEST_ATTRIBUTES=data-cy) takes the attribute-CSS form.
      name: "tier 1: non-default test attribute lowers to attribute-CSS via page.locator",
      input: { role: "div", testId: "submit-form", testIdAttr: "data-cy", source: "dom" },
      playwright: `page.locator('[data-cy="submit-form"]')`,
      stability: "high",
      components: [{ kind: "testid", value: "submit-form", attribute: "data-cy" }],
    },
    {
      name: "tier 2: DOM-only ref without testId lowers via cssPath (semantic anchor)",
      input: {
        role: "td",
        cssPath: "main > table > tbody > tr:nth-child(4) > td:nth-child(3)",
        source: "dom",
      },
      playwright: "page.locator('main > table > tbody > tr:nth-child(4) > td:nth-child(3)')",
      stability: "medium",
      components: [
        { kind: "css", value: "main > table > tbody > tr:nth-child(4) > td:nth-child(3)" },
      ],
    },
    {
      // A path that is entirely `:nth-child` chains under generic tags carries no
      // semantic anchor, so `find()` would have called it `low` too.
      name: "tier 2: positional-only DOM cssPath falls back to stability low",
      input: {
        role: "div",
        cssPath: "div > div:nth-child(2) > div:nth-child(5) > div",
        source: "dom",
      },
      stability: "low",
    },
    {
      name: "tier 3: role + name lowers to getByRole({ name })",
      input: { role: "button", name: "Save", source: "a11y" },
      playwright: "page.getByRole('button', { name: 'Save' })",
      stability: "high",
      components: [
        { kind: "role", value: "button", name: "Save" },
        { kind: "text", value: "Save" },
      ],
    },
    {
      name: "tier 4: cssPath fallback for `both` refs without name",
      input: { role: "generic", cssPath: "form > div:nth-child(2)", source: "both" },
      playwright: "page.locator('form > div:nth-child(2)')",
      stability: "medium",
    },
    {
      name: "tier 5: role-only fallback returns getByRole(role)",
      input: { role: "button", source: "a11y" },
      playwright: "page.getByRole('button')",
      stability: "low",
      components: [{ kind: "role", value: "button" }],
    },
    {
      // `O'Brien` would break a single-quoted JS string literal if emitted bare;
      // the expression must be paste-safe into a .spec.ts.
      name: "escapes single quotes inside accessible names",
      input: { role: "button", name: "O'Brien", source: "a11y" },
      playwright: `page.getByRole('button', { name: 'O\\'Brien' })`,
    },
  ] as Array<{
    name: string;
    input: Parameters<typeof generatePlaywrightLocator>[0];
    playwright?: string;
    stability?: string;
    components?: unknown[];
  }>)("$name", ({ input, playwright, stability, components }) => {
    const out = generatePlaywrightLocator(input);
    if (playwright !== undefined) expect(out.playwright).toBe(playwright);
    if (stability !== undefined) expect(out.stability).toBe(stability);
    if (components !== undefined) expect(out.components).toEqual(components);
  });
});

describe("generateLocator — registry lookup", () => {
  it("returns structured failure when the ref is not registered", () => {
    const refs = new RefRegistry();
    const out = generateLocator("e999", (ref) => refs.locatorOf(ref));
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.failure.kind).toBe("ref-not-found");
      expect(out.failure.ref).toBe("e999");
      expect(out.failure.hint).toMatch(/snapshot\(\)|find\(\)/);
    }
  });

  it("returns a success envelope on hit", () => {
    const refs = new RefRegistry();
    const inputs: RefLocatorInputs = {
      role: "button",
      name: "Save",
      source: "a11y",
    };
    const ref = refs.forKey("k1", inputs);
    const out = generateLocator(ref, (r) => refs.locatorOf(r));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.playwright).toBe("page.getByRole('button', { name: 'Save' })");
      expect(out.stability).toBe("high");
    }
  });
});
