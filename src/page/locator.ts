// Resolve a `ref` (from snapshot()/find()) or a `selector` (raw CSS / Playwright
// locator string) into a Playwright Locator we can act on. Refs are the preferred
// path: they're stable across snapshots and built from role+name(+testId), which
// gives Playwright auto-waiting + strict-match for free.

import type { Locator, Page } from "playwright-core";
import type { RefLocatorInputs, RefRegistry } from "./refs.js";

/**
 * Action target shape. Exactly one of `ref` / `selector` / `coords` is
 * required. `contextRef` optionally scopes a `selector` to the subtree of a
 * prior ref — lets callers say "the [data-testid=...] *inside this row*"
 * without baking positional `:nth` chains into the selector. `coords` is the
 * escape hatch for visually-located targets (canvas, custom-painted UIs,
 * dismiss-empty-space) that ref/selector resolution genuinely can't address.
 */
export type ActionTarget =
  | { ref: string; selector?: undefined; contextRef?: undefined; coords?: undefined }
  | { selector: string; ref?: undefined; contextRef?: string; coords?: undefined }
  | { coords: { x: number; y: number }; ref?: undefined; selector?: undefined; contextRef?: undefined };

export type ResolvedTarget =
  | { kind: "locator"; loc: Locator }
  | { kind: "coords"; x: number; y: number };

export function resolveTarget(page: Page, refs: RefRegistry, target: ActionTarget): ResolvedTarget {
  if (target.coords) {
    return { kind: "coords", x: target.coords.x, y: target.coords.y };
  }
  return { kind: "locator", loc: locatorFor(page, refs, target) };
}

/**
 * Ambiguity-aware target resolution for the *acting* path. A ref built from a
 * signal that is shared across repeated / hover-revealed items (e.g. a
 * `data-testid` reused on every row's edit button) resolves via `.first()` to
 * whatever instance is first in the DOM — which can be a *different* visible
 * element than the one the agent found, so the action silently lands at the
 * wrong visual location. When the primary locator matches more than one node
 * and the ref carries the concrete structural path it was discovered as,
 * re-resolve to that concrete element and surface a warning. Verify-before-
 * dispatch: a loud "I re-resolved" beats a silent wrong-place click.
 */
export async function resolveTargetChecked(
  page: Page,
  refs: RefRegistry,
  target: ActionTarget,
): Promise<{ resolved: ResolvedTarget; warning?: string }> {
  if (target.coords || !target.ref) {
    return { resolved: resolveTarget(page, refs, target) };
  }
  const primary = locatorFor(page, refs, target);
  const inputs = refs.locatorOf(target.ref);
  if (!inputs?.cssPath) return { resolved: { kind: "locator", loc: primary } };
  let count: number;
  try {
    count = await primary.count();
  } catch {
    count = 1; // can't tell → don't second-guess the primary path
  }
  if (count <= 1) return { resolved: { kind: "locator", loc: primary } };
  const concrete = page.locator(inputs.cssPath).first();
  let concreteCount: number;
  try {
    concreteCount = await concrete.count();
  } catch {
    concreteCount = 0;
  }
  if (concreteCount >= 1) {
    return {
      resolved: { kind: "locator", loc: concrete },
      warning:
        `ref "${target.ref}": the primary locator matched ${count} nodes ` +
        `(ambiguous — likely a shared test-id across repeated/overlay items). ` +
        `Re-resolved to the concrete element captured when the ref was found, ` +
        `to avoid acting at the wrong visual location.`,
    };
  }
  return {
    resolved: { kind: "locator", loc: primary },
    warning:
      `ref "${target.ref}": the primary locator is ambiguous (${count} matches) ` +
      `and the concrete path captured at discovery no longer resolves; acting ` +
      `on .first() — verify the result, the element may have moved or re-rendered.`,
  };
}

export function locatorFor(page: Page, refs: RefRegistry, target: ActionTarget): Locator {
  if (target.coords) {
    throw new Error("locatorFor: coords target has no Locator — use resolveTarget() and switch on kind");
  }
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
  throw new Error("locatorFor: requires { ref } or { selector } (with optional { contextRef } for scoped selectors) or { coords }");
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
