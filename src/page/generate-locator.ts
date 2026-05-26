// generate_locator(ref) — adopter-facing bridge from a browxai-internal `eN` ref
// to a *Playwright-string* locator expression an adopter can paste into a
// `.spec.ts`.
//
// browxai's internal locator-resolution machinery (locator.ts) takes a
// `RefLocatorInputs` record and produces a live Playwright `Locator` object on
// the page. That's the right shape for *acting* in-process; it's the wrong
// shape for the regression-suite handoff use case, where the adopter needs a
// *string* they can transcribe verbatim into their own test file.
//
// This module mirrors the resolution priority in `locatorFromInputs` exactly
// — testId → DOM cssPath (for DOM-only refs) → role+name → cssPath → role-only
// — so the string we hand back lines up with the locator browxai itself would
// resolve at action time. It also emits a structured `components` breakdown
// (the parts that built the string) and a `stability` label derived from the
// same tier system `find()` already uses.

import type { RefLocatorInputs } from "./refs.js";

/** A `generate_locator` result, suitable for pasting into a `.spec.ts`. */
export interface GeneratedLocator {
  /** A Playwright locator expression — e.g. `page.getByRole('button', { name: 'Save' })`
   *  or `page.getByTestId('save-btn')` or `page.locator('table > tbody > tr:nth-child(4)')`.
   *  Always rooted on the bare identifier `page` so the adopter can rename
   *  ergonomically (`const saveBtn = page.getByRole(...)`). */
  playwright: string;
  /** Per-tier stability label, same vocabulary `find()` already emits.
   *   high   — testid OR role+name (uniquely identifies the element via a stable signal)
   *   medium — stable text on a stable role OR stable structural path
   *   low    — positional / role-only (likely to drift on the next render)
   */
  stability: "high" | "medium" | "low";
  /** Structured breakdown of the parts the locator string is built from.
   *  Adopters who want to compose their own locator (e.g. chain `.filter()`
   *  or combine two kinds) can read this without re-parsing the string. */
  components: GeneratedLocatorComponent[];
}

export interface GeneratedLocatorComponent {
  kind: "testid" | "role" | "text" | "css";
  value: string;
  /** Present on `role` components when an accessible name disambiguated the role. */
  name?: string;
  /** Present on `testid` components when a non-default test-attribute name
   *  drove the match (e.g. `data-cy`, `data-type`). */
  attribute?: string;
}

/** Structured failure shape — ref-not-found returns this rather than throwing. */
export interface GenerateLocatorFailure {
  ok: false;
  failure: {
    kind: "ref-not-found";
    ref: string;
    hint: string;
  };
}

export interface GenerateLocatorSuccess extends GeneratedLocator {
  ok: true;
}

export type GenerateLocatorResult = GenerateLocatorSuccess | GenerateLocatorFailure;

/**
 * Build a Playwright-string locator + structured breakdown for a `RefLocatorInputs`.
 *
 * Priority (mirrors `locatorFromInputs` in `locator.ts`):
 *   1. testId present                                        → getByTestId / [attr="…"]      (high)
 *   2. DOM-only ref without testId, cssPath present          → locator(cssPath)              (medium / low)
 *   3. role + accessible name                                → getByRole(role, { name })     (high)
 *   4. cssPath fallback (e.g. `both` refs that lost the name)→ locator(cssPath)              (medium / low)
 *   5. role only                                             → getByRole(role)               (low)
 */
export function generatePlaywrightLocator(inputs: RefLocatorInputs): GeneratedLocator {
  // Tier 1: testId. Default `data-testid` lowers to `getByTestId` (Playwright's
  // ergonomic helper); any other configured attribute lowers to the attribute
  // CSS form so non-standard test attributes (`data-cy`, `data-type`) Just Work.
  if (inputs.testId) {
    const attr = inputs.testIdAttr ?? "data-testid";
    if (attr === "data-testid") {
      return {
        playwright: `page.getByTestId(${jsStringLiteral(inputs.testId)})`,
        stability: "high",
        components: [{ kind: "testid", value: inputs.testId }],
      };
    }
    const cssAttr = `[${attr}=${jsonAttrValue(inputs.testId)}]`;
    return {
      playwright: `page.locator(${jsStringLiteral(cssAttr)})`,
      stability: "high",
      components: [{ kind: "testid", value: inputs.testId, attribute: attr }],
    };
  }

  // Tier 2: DOM-only refs (no a11y name available) — the structural path is
  // the only signal we have. Stability is medium when the path looks stable
  // (semantic anchors / id / data-attrs) and low when it's purely positional
  // (`:nth-child` chains all the way down).
  if (inputs.source === "dom" && inputs.cssPath) {
    return cssPathLocator(inputs.cssPath);
  }

  // Tier 3: role + accessible name — strong when the a11y pass saw it.
  // Stability "high": role+name is one of Playwright's most resilient signals
  // (it survives DOM reshuffling as long as the control's accessible name
  // doesn't change).
  if (inputs.name) {
    const role = inputs.role;
    return {
      playwright: `page.getByRole(${jsStringLiteral(role)}, { name: ${jsStringLiteral(inputs.name)} })`,
      stability: "high",
      components: [
        { kind: "role", value: role, name: inputs.name },
        { kind: "text", value: inputs.name },
      ],
    };
  }

  // Tier 4: cssPath fallback for `both` refs that the a11y pass saw without a
  // name. Same stability heuristic as tier 2.
  if (inputs.cssPath) {
    return cssPathLocator(inputs.cssPath);
  }

  // Tier 5: role only. The agent saw `stability: "low"` from `find()` — same
  // verdict here.
  return {
    playwright: `page.getByRole(${jsStringLiteral(inputs.role)})`,
    stability: "low",
    components: [{ kind: "role", value: inputs.role }],
  };
}

/** Build a `page.locator(...)` for a structural CSS path, deriving stability
 *  from whether the path is purely positional. A path that's entirely
 *  `:nth-child(N)` segments under generic tags is `low`; a path with semantic
 *  anchors, ids, or stable test attributes is `medium`. */
function cssPathLocator(cssPath: string): GeneratedLocator {
  return {
    playwright: `page.locator(${jsStringLiteral(cssPath)})`,
    stability: cssPathStability(cssPath),
    components: [{ kind: "css", value: cssPath }],
  };
}

/** A CSS path is "stable-structural" (medium) when it carries at least one
 *  non-positional anchor — an `#id`, a `[data-*]`/`[aria-*]`/`[role=]` attribute
 *  selector, or a semantic landmark tag (`main`, `nav`, `header`, `footer`,
 *  `aside`, `form`, `section`, `article`). Otherwise it's purely positional
 *  (chains of `:nth-child`/bare tags) and falls back to `low`. */
function cssPathStability(cssPath: string): "medium" | "low" {
  if (/#[A-Za-z]/.test(cssPath)) return "medium";
  if (/\[(data-|aria-|role=|id=|name=)/.test(cssPath)) return "medium";
  if (/\b(main|nav|header|footer|aside|form|section|article)\b/.test(cssPath)) return "medium";
  return "low";
}

/** JS string literal — single-quoted, with backslash + single-quote escapes.
 *  Matches Playwright's own examples (`page.getByRole('button', { name: 'Save' })`). */
function jsStringLiteral(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** CSS attribute-value JSON form — double-quoted, escapes only `\` and `"`.
 *  Used inside a bigger JS string literal that we'll quote separately. */
function jsonAttrValue(s: string): string {
  return JSON.stringify(s);
}

/** Top-level entry: look the ref up in a registry-shaped lookup and produce
 *  either a structured success or a structured ref-not-found failure. The
 *  generator is split from the registry lookup so unit tests can drive it
 *  directly from `RefLocatorInputs`. */
export function generateLocator(
  ref: string,
  lookup: (ref: string) => RefLocatorInputs | undefined,
): GenerateLocatorResult {
  const inputs = lookup(ref);
  if (!inputs) {
    return {
      ok: false,
      failure: {
        kind: "ref-not-found",
        ref,
        hint:
          `ref "${ref}" is not in this session's registry. Call snapshot() or find() first ` +
          `to populate refs (refs survive across snapshots by stable element-key, but a fresh ` +
          `session starts empty).`,
      },
    };
  }
  return { ok: true, ...generatePlaywrightLocator(inputs) };
}
