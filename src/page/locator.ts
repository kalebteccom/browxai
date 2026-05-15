// Resolve a `ref` (from snapshot()/find()) or a `selector` (raw CSS / Playwright
// locator string) into a Playwright Locator we can act on. Refs are the preferred
// path: they're stable across snapshots and built from role+name(+testId), which
// gives Playwright auto-waiting + strict-match for free.

import type { Locator, Page } from "playwright-core";
import type { RefLocatorInputs, RefRegistry } from "./refs.js";

/**
 * Action target shape. Exactly one of `ref` / `selector` is required.
 * `contextRef` optionally scopes a `selector` to the subtree of a prior ref —
 * lets callers say "the [data-testid=...] *inside this row*" without baking
 * positional `:nth` chains into the selector. Mirrors `find()`'s `contextRef`
 * but composes at locator-resolution time rather than at tree-search time.
 */
export type ActionTarget =
  | { ref: string; selector?: undefined; contextRef?: undefined }
  | { selector: string; ref?: undefined; contextRef?: string };

export function locatorFor(page: Page, refs: RefRegistry, target: ActionTarget): Locator {
  if (target.ref) {
    const inputs = refs.locatorOf(target.ref);
    if (!inputs) {
      throw new Error(
        `unknown ref "${target.ref}"; call snapshot() or find() first to populate refs, or pass a selector instead`,
      );
    }
    return locatorFromInputs(page, inputs);
  }
  if (target.selector) {
    if (target.contextRef) {
      const ctxInputs = refs.locatorOf(target.contextRef);
      if (!ctxInputs) {
        throw new Error(
          `unknown contextRef "${target.contextRef}"; call snapshot() or find() first to populate refs`,
        );
      }
      const ctxLoc = locatorFromInputs(page, ctxInputs);
      return parseSelectorHint(ctxLoc, target.selector);
    }
    return parseSelectorHint(page, target.selector);
  }
  throw new Error("locatorFor: requires { ref } or { selector } (with optional { contextRef } for scoped selectors)");
}

function locatorFromInputs(page: Page, inputs: RefLocatorInputs): Locator {
  // Tier 1: testId — strongest signal, works for any provenance. CSS attribute
  // form rather than Playwright's `getByTestId` so non-standard test attributes
  // (`data-type`, `data-cy`, etc.) work without per-context plumbing.
  if (inputs.testId) {
    const attr = inputs.testIdAttr ?? "data-testid";
    return page.locator(`[${attr}=${JSON.stringify(inputs.testId)}]`).first();
  }
  // Provenance-aware routing: refs discovered exclusively via the DOM walk
  // typically carry bare-tag roles (`td`, `div`, `generic`) whose role-locators
  // are ambiguous or don't actually resolve. Prefer the structural CSS path
  // captured at walk time.
  if (inputs.source === "dom" && inputs.cssPath) {
    return page.locator(inputs.cssPath).first();
  }
  // Tier 2: role + name — strong when the a11y pass saw it.
  if (inputs.name) {
    return page.getByRole(inputs.role as Parameters<Page["getByRole"]>[0], { name: inputs.name }).first();
  }
  // Fallback: structural path (covers `source: "both"` refs where the a11y
  // pass produced no name, plus the rare migration case of legacy refs that
  // never got a name).
  if (inputs.cssPath) {
    return page.locator(inputs.cssPath).first();
  }
  // Last resort: role only. Often ambiguous; the agent saw stability=low.
  return page.getByRole(inputs.role as Parameters<Page["getByRole"]>[0]).first();
}

/**
 * Parse a small subset of selector strings that find() emits as `selectorHint`
 * (so consumers can pass them straight back as `selector:`). Falls through to
 * a raw Playwright locator string for anything else.
 *
 * Accepts either a Page or a Locator as the resolution root — when the caller
 * supplies a `contextRef`, the scope is a Locator and selectors resolve inside
 * its subtree (Playwright's nested-locator semantics).
 *
 * Supported shapes:
 *   - `[<attr>="..."]`                   → locator(attr-CSS)
 *   - `role=<role>[name="..."]`          → getByRole({ name })
 *   - `role=<role>`                      → getByRole
 *   - anything else                      → locator(<raw>)
 */
interface SelectorRoot {
  locator: (selector: string) => Locator;
  getByRole: Page["getByRole"];
}
function parseSelectorHint(root: SelectorRoot, sel: string): Locator {
  const s = sel.trim();
  const attrMatch = s.match(/^\[([a-zA-Z][a-zA-Z0-9-]*)=("([^"]*)"|'([^']*)')\]$/);
  if (attrMatch) {
    return root.locator(s).first();
  }
  const roleWithNameMatch = s.match(/^role=([a-zA-Z][a-zA-Z0-9-]*)\[name=("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\]$/);
  if (roleWithNameMatch) {
    const role = roleWithNameMatch[1]!;
    const raw = roleWithNameMatch[3] ?? roleWithNameMatch[4] ?? "";
    const name = raw.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    return root.getByRole(role as Parameters<Page["getByRole"]>[0], { name }).first();
  }
  const roleOnlyMatch = s.match(/^role=([a-zA-Z][a-zA-Z0-9-]*)$/);
  if (roleOnlyMatch) {
    return root.getByRole(roleOnlyMatch[1] as Parameters<Page["getByRole"]>[0]).first();
  }
  return root.locator(s).first();
}
