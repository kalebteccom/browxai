// Resolve a `ref` (from snapshot()/find()) or a `selector` (raw CSS / Playwright
// locator string) into a Playwright Locator we can act on. Refs are the preferred
// path: they're stable across snapshots and built from role+name(+testId), which
// gives Playwright auto-waiting + strict-match for free.

import type { Locator, Page } from "playwright-core";
import type { RefLocatorInputs, RefRegistry } from "./refs.js";

export type ActionTarget =
  | { ref: string; selector?: undefined }
  | { selector: string; ref?: undefined };

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
    return parseSelectorHint(page, target.selector);
  }
  throw new Error("locatorFor: requires { ref } or { selector }");
}

function locatorFromInputs(page: Page, inputs: RefLocatorInputs): Locator {
  // Tier-1 preference: testId. Use Playwright's typed test-id helper which
  // matches whatever attribute is configured (defaults to data-testid).
  if (inputs.testId) {
    return page.getByTestId(inputs.testId).first();
  }
  // Tier 2: role + name.
  if (inputs.name) {
    return page.getByRole(inputs.role as Parameters<Page["getByRole"]>[0], { name: inputs.name }).first();
  }
  // Tier 5 fallback: just the role. Often ambiguous; the agent saw stability=low.
  return page.getByRole(inputs.role as Parameters<Page["getByRole"]>[0]).first();
}

/**
 * Parse a small subset of selector strings that find() emits as `selectorHint`
 * (so consumers can pass them straight back as `selector:`). Falls through to
 * a raw Playwright locator string for anything else.
 *
 * Supported shapes:
 *   - `[data-testid="..."]`              → getByTestId
 *   - `role=<role>[name="..."]`          → getByRole({ name })
 *   - `role=<role>`                      → getByRole
 *   - anything else                      → page.locator(<raw>)
 */
function parseSelectorHint(page: Page, sel: string): Locator {
  const s = sel.trim();
  const testIdMatch = s.match(/^\[data-testid=("([^"]*)"|'([^']*)')\]$/);
  if (testIdMatch) {
    const v = testIdMatch[2] ?? testIdMatch[3] ?? "";
    return page.getByTestId(v).first();
  }
  const roleWithNameMatch = s.match(/^role=([a-zA-Z][a-zA-Z0-9-]*)\[name=("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\]$/);
  if (roleWithNameMatch) {
    const role = roleWithNameMatch[1]!;
    const raw = roleWithNameMatch[3] ?? roleWithNameMatch[4] ?? "";
    const name = raw.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    return page.getByRole(role as Parameters<Page["getByRole"]>[0], { name }).first();
  }
  const roleOnlyMatch = s.match(/^role=([a-zA-Z][a-zA-Z0-9-]*)$/);
  if (roleOnlyMatch) {
    return page.getByRole(roleOnlyMatch[1] as Parameters<Page["getByRole"]>[0]).first();
  }
  return page.locator(s).first();
}
