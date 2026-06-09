import { describe, it, expect } from "vitest";
import { RefRegistry, type RefLocatorInputs } from "./refs.js";
import { generateLocator, generatePlaywrightLocator } from "./generate-locator.js";

describe("generatePlaywrightLocator — tier mapping", () => {
  it("tier 1: default data-testid lowers to getByTestId, stability high", () => {
    const out = generatePlaywrightLocator({
      role: "button",
      testId: "save-btn",
      testIdAttr: "data-testid",
      source: "dom",
    });
    expect(out.playwright).toBe("page.getByTestId('save-btn')");
    expect(out.stability).toBe("high");
    expect(out.components).toEqual([{ kind: "testid", value: "save-btn" }]);
  });

  it("tier 1: non-default test attribute lowers to attribute-CSS via page.locator", () => {
    // Adopters configuring `BROWX_TEST_ATTRIBUTES=data-cy` get the same
    // strength signal, but `getByTestId` is locked to `data-testid`, so the
    // attribute form is the correct emission.
    const out = generatePlaywrightLocator({
      role: "div",
      testId: "submit-form",
      testIdAttr: "data-cy",
      source: "dom",
    });
    expect(out.playwright).toBe(`page.locator('[data-cy="submit-form"]')`);
    expect(out.stability).toBe("high");
    expect(out.components).toEqual([
      { kind: "testid", value: "submit-form", attribute: "data-cy" },
    ]);
  });

  it("tier 2: DOM-only ref without testId lowers via cssPath, stability medium (semantic anchor)", () => {
    const out = generatePlaywrightLocator({
      role: "td",
      cssPath: "main > table > tbody > tr:nth-child(4) > td:nth-child(3)",
      source: "dom",
    });
    expect(out.playwright).toBe(
      "page.locator('main > table > tbody > tr:nth-child(4) > td:nth-child(3)')",
    );
    expect(out.stability).toBe("medium");
    expect(out.components).toEqual([
      {
        kind: "css",
        value: "main > table > tbody > tr:nth-child(4) > td:nth-child(3)",
      },
    ]);
  });

  it("tier 2: positional-only DOM cssPath falls back to stability low", () => {
    // A path that is entirely `:nth-child` chains under generic tags carries
    // no semantic anchor — the next render can easily reshuffle it. `find()`
    // would have called this `low`; mirror that.
    const out = generatePlaywrightLocator({
      role: "div",
      cssPath: "div > div:nth-child(2) > div:nth-child(5) > div",
      source: "dom",
    });
    expect(out.stability).toBe("low");
  });

  it("tier 3: role + name lowers to getByRole({ name }), stability high", () => {
    const out = generatePlaywrightLocator({
      role: "button",
      name: "Save",
      source: "a11y",
    });
    expect(out.playwright).toBe("page.getByRole('button', { name: 'Save' })");
    expect(out.stability).toBe("high");
    expect(out.components).toEqual([
      { kind: "role", value: "button", name: "Save" },
      { kind: "text", value: "Save" },
    ]);
  });

  it("tier 4: cssPath fallback for `both` refs without name, stability medium when semantic", () => {
    const out = generatePlaywrightLocator({
      role: "generic",
      cssPath: "form > div:nth-child(2)",
      source: "both",
    });
    expect(out.playwright).toBe("page.locator('form > div:nth-child(2)')");
    expect(out.stability).toBe("medium");
  });

  it("tier 5: role-only fallback returns getByRole(role), stability low", () => {
    const out = generatePlaywrightLocator({ role: "button", source: "a11y" });
    expect(out.playwright).toBe("page.getByRole('button')");
    expect(out.stability).toBe("low");
    expect(out.components).toEqual([{ kind: "role", value: "button" }]);
  });

  it("escapes single quotes inside accessible names", () => {
    // A name like `O'Brien` would break a single-quoted JS string literal if
    // emitted bare. The emitted expression must be paste-safe into a .spec.ts.
    const out = generatePlaywrightLocator({
      role: "button",
      name: "O'Brien",
      source: "a11y",
    });
    expect(out.playwright).toBe(`page.getByRole('button', { name: 'O\\'Brien' })`);
  });

  it("escapes backslashes inside testId values", () => {
    const out = generatePlaywrightLocator({
      role: "button",
      testId: "back\\slash",
      testIdAttr: "data-testid",
      source: "dom",
    });
    expect(out.playwright).toBe(`page.getByTestId('back\\\\slash')`);
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
