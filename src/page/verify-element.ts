// Element-bound `verify_*` helpers — visible / text / value / attribute. Each
// resolves a single `ActionTarget` to a Locator (via the shared `resolveOrFail`
// in `./verify-types.js`), reads one piece of element state, and emits the
// structured pass/fail result. Split out of verify.ts so the per-element
// assertions live apart from the count/predicate verifies; re-exported through
// `./verify.js`.
//
// All four share the same ref-no-longer-found shape: when the ref doesn't
// resolve in the current snapshot, `resolveOrFail` fails with `source:"browxai"`
// so the agent can tell "the app's wrong" apart from "the snapshot rolled and
// the ref evaporated."

import type { Locator, Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import type { ActionTarget } from "./locator.js";
import { resolveOrFail, type VerifyResult } from "./verify-types.js";

/** Verify that the targeted element is visible (non-zero box, not
 *  display:none/visibility:hidden, opacity > 0). `source:"app"` on miss. */
export async function verifyVisible(
  page: Page,
  refs: RefRegistry,
  target: ActionTarget,
): Promise<VerifyResult> {
  const expected = "visible (non-zero box, displayed, opacity > 0)";
  const resolved = resolveOrFail(page, refs, target, "visible", expected);
  if (!resolved.ok) return resolved;
  const { loc } = resolved;
  try {
    const count = await loc.count();
    if (count === 0) {
      return {
        ok: false,
        failure: {
          source: "app",
          kind: "visible",
          expected,
          actual: "missing (locator matched 0 nodes)",
        },
      };
    }
    const isVisible = await loc.first().isVisible();
    if (isVisible) return { ok: true };
    // Distinguish off-screen vs hidden where we can.
    const reason = await probeNotVisibleReason(loc.first());
    return {
      ok: false,
      failure: {
        source: "app",
        kind: "visible",
        expected,
        actual: reason,
      },
    };
  } catch (e) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind: "visible",
        expected,
        actual: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

async function probeNotVisibleReason(loc: Locator): Promise<string> {
  try {
    return await loc
      .evaluate((el: Element): string => {
        const cs = window.getComputedStyle(el);
        if (cs.display === "none") return "hidden (display:none)";
        if (cs.visibility === "hidden") return "hidden (visibility:hidden)";
        if (Number(cs.opacity || "1") === 0) return "hidden (opacity:0)";
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return "hidden (zero-sized box)";
        return "off-screen or covered";
      })
      .catch(() => "hidden");
  } catch {
    return "hidden";
  }
}

/** Verify that the targeted element's visible text matches. `exact:true` →
 *  case-sensitive equality on the trimmed innerText. Default → case-insensitive
 *  substring. `source:"app"` on miss. */
export async function verifyText(
  page: Page,
  refs: RefRegistry,
  target: ActionTarget,
  text: string,
  exact: boolean,
): Promise<VerifyResult> {
  const expected = exact
    ? `text === ${JSON.stringify(text)}`
    : `text includes ${JSON.stringify(text)}`;
  const resolved = resolveOrFail(page, refs, target, "text", expected);
  if (!resolved.ok) return resolved;
  const { loc } = resolved;
  try {
    if ((await loc.count()) === 0) {
      return {
        ok: false,
        failure: {
          source: "app",
          kind: "text",
          expected,
          actual: "missing (locator matched 0 nodes)",
        },
      };
    }
    const actualText =
      (await loc
        .first()
        .innerText()
        .catch(() => null)) ?? "";
    const trimmed = actualText.trim();
    const hit = exact ? trimmed === text : trimmed.toLowerCase().includes(text.toLowerCase());
    if (hit) return { ok: true };
    return {
      ok: false,
      failure: {
        source: "app",
        kind: "text",
        expected,
        actual: trimmed.slice(0, 200),
        evidence: { exact, length: trimmed.length },
      },
    };
  } catch (e) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind: "text",
        expected,
        actual: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

/** Verify that the targeted input/textarea/contenteditable carries the given
 *  value (strict equality after a defensive `String()`). `source:"app"` on
 *  miss. */
export async function verifyValue(
  page: Page,
  refs: RefRegistry,
  target: ActionTarget,
  value: string,
): Promise<VerifyResult> {
  const expected = `value === ${JSON.stringify(value)}`;
  const resolved = resolveOrFail(page, refs, target, "value", expected);
  if (!resolved.ok) return resolved;
  const { loc } = resolved;
  try {
    if ((await loc.count()) === 0) {
      return {
        ok: false,
        failure: {
          source: "app",
          kind: "value",
          expected,
          actual: "missing (locator matched 0 nodes)",
        },
      };
    }
    const actual = await loc
      .first()
      .evaluate((el: Element): string | null => {
        // Any element carrying a string `value` (input/textarea/select, but
        // also output/button/etc.) reports it directly; a contenteditable host
        // falls back to its rendered text. Structural checks mirror the DOM
        // surface without assuming a single concrete element type.
        const valued = el as Element & { value?: unknown };
        if (typeof valued.value === "string") return valued.value;
        if (el instanceof HTMLElement && el.isContentEditable) return el.innerText ?? "";
        return null;
      })
      .catch(() => null);
    if (actual === null) {
      return {
        ok: false,
        failure: {
          source: "app",
          kind: "value",
          expected,
          actual: "element has no `value` (not an input/textarea/select/contenteditable)",
        },
      };
    }
    if (String(actual) === value) return { ok: true };
    return {
      ok: false,
      failure: {
        source: "app",
        kind: "value",
        expected,
        actual: String(actual).slice(0, 200),
      },
    };
  } catch (e) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind: "value",
        expected,
        actual: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

/** Verify that the targeted element's `attr` attribute equals `value`. When
 *  `value` is undefined, this asserts the attribute is present (any value).
 *  `source:"app"` on miss. */
export async function verifyAttribute(
  page: Page,
  refs: RefRegistry,
  target: ActionTarget,
  attr: string,
  value: string | undefined,
): Promise<VerifyResult> {
  const expected =
    value === undefined
      ? `attribute "${attr}" is present`
      : `attribute "${attr}" === ${JSON.stringify(value)}`;
  const resolved = resolveOrFail(page, refs, target, "attribute", expected);
  if (!resolved.ok) return resolved;
  const { loc } = resolved;
  try {
    if ((await loc.count()) === 0) {
      return {
        ok: false,
        failure: {
          source: "app",
          kind: "attribute",
          expected,
          actual: "missing (locator matched 0 nodes)",
        },
      };
    }
    const actual = await loc
      .first()
      .getAttribute(attr)
      .catch(() => null);
    if (value === undefined) {
      if (actual !== null) return { ok: true };
      return {
        ok: false,
        failure: {
          source: "app",
          kind: "attribute",
          expected,
          actual: null,
          evidence: { attr },
        },
      };
    }
    if (actual === value) return { ok: true };
    return {
      ok: false,
      failure: {
        source: "app",
        kind: "attribute",
        expected,
        actual,
        evidence: { attr },
      },
    };
  } catch (e) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind: "attribute",
        expected,
        actual: e instanceof Error ? e.message : String(e),
      },
    };
  }
}
