// `verify_*` assertive read primitives.
//
// `wait_for` is *permissive* — it returns when satisfied OR when its deadline
// expires with `ok:false`. That leaves agents writing loops that can't
// terminate deterministically. The verify family is the assertive sibling:
// "this element MUST be visible / this text MUST appear / this value MUST
// equal X right now — else fail loudly." A failed verify always emits a
// structured `{source:"app", expected, actual}` failure, never a warning the
// LLM has to eyeball.
//
// Each helper is pure plumbing — it resolves the target, reads the relevant
// piece of state, and returns one of:
//   { ok: true }
//   { ok: false, failure: { source, kind, expected, actual, evidence? } }
//
// All five element-level helpers share the same ref-no-longer-found shape:
// when the ref doesn't resolve in the current snapshot, they fail with
// `source:"browxai"` so the agent can tell "the app's wrong" apart from
// "the snapshot rolled and the ref evaporated."
//
// `verify_predicate` (the composed-data helper) delegates to the shared
// predicate vocabulary in `src/util/predicates.ts` — same vocabulary that
// underwrites `batch.expect`. It deliberately accepts NO arbitrary-JS
// expression: the predicate `kind` is a fixed enum and the accessor `key` is
// constrained to an allow-list of namespaced paths into a small data bag the
// caller supplies. `eval_js` (gated behind the `eval` capability) is the only
// arbitrary-JS escape hatch in browxai — the verify family does not add a
// second one.

import type { Locator, Page, CDPSession } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { composeSnapshot } from "./compose.js";
import { findByRef } from "./snapshot.js";
import { searchTreeForText } from "./text_search.js";
import { walk } from "./a11y.js";
import { visibleRect } from "./bbox.js";
import { locatorFor, type ActionTarget } from "./locator.js";
import {
  evaluatePredicate,
  validatePredicate,
  type Predicate,
  type PredicateResult,
} from "../util/predicates.js";
import type { FailureSource as FailureSourceBase } from "../util/failure.js";

// The verify family only ever emits the two determinate sources — `app`
// (predicate didn't hold) or `browxai` (verify itself couldn't run).
// `unknown` belongs to the post-hoc error classifier in `util/failure.ts`
// and is intentionally excluded here. Narrowing rather than redeclaring
// keeps both surfaces speaking the same vocabulary.
export type FailureSource = Extract<FailureSourceBase, "app" | "browxai">;

export interface VerifyFailure {
  /** `app` when the predicate didn't hold against the page's actual state;
   *  `browxai` when the verify itself couldn't run (ref no longer in the
   *  snapshot, selector matched nothing the helper could resolve, etc). */
  source: FailureSource;
  /** Stable kind label — `"visible"`, `"text-equals"`, `"value-equals"`,
   *  `"count-equals"`, `"attribute-equals"`, predicate kind for `verify_predicate`. */
  kind: string;
  /** Human-readable description of what should have held. */
  expected: string;
  /** What we actually saw — the value/state that didn't match. */
  actual: unknown;
  /** Optional supporting context (matched-text fragment, the ref's role,
   *  a count breakdown). Kept small so the result fits the token budget. */
  evidence?: Record<string, unknown>;
}

export interface VerifyResult {
  ok: boolean;
  failure?: VerifyFailure;
}

/** Resolve an `ActionTarget` to a Playwright Locator + the rich ref evidence,
 *  failing-emitting (`source:"browxai"`) when a ref isn't in the registry. */
function resolveOrFail(
  page: Page,
  refs: RefRegistry,
  target: ActionTarget,
  kind: string,
  expected: string,
): { ok: true; loc: Locator; ref?: string } | { ok: false; failure: VerifyFailure } {
  if (target.coords) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind,
        expected,
        actual: "coords target",
        evidence: { hint: "verify_* helpers don't accept coords targets — use ref/selector/named" },
      },
    };
  }
  if (target.ref) {
    if (!refs.has(target.ref)) {
      return {
        ok: false,
        failure: {
          source: "browxai",
          kind,
          expected,
          actual: "ref no longer in the snapshot",
          evidence: {
            ref: target.ref,
            hint: "call snapshot() or find() again — the page may have re-rendered",
          },
        },
      };
    }
  }
  let loc: Locator;
  try {
    loc = locatorFor(page, refs, target);
  } catch (e) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind,
        expected,
        actual: e instanceof Error ? e.message : String(e),
      },
    };
  }
  return { ok: true, loc, ...(target.ref ? { ref: target.ref } : {}) };
}

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

/** Verify that exactly `n` elements match the given selector (or visible-text
 *  search). One of `selector` or `text` is required. `source:"app"` on miss. */
export async function verifyCount(
  page: Page,
  cdp: CDPSession,
  refs: RefRegistry,
  opts: { selector?: string; text?: string; n: number; testAttributes: string[] },
): Promise<VerifyResult> {
  if (opts.selector && opts.text) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind: "count",
        expected: `exactly one of selector / text`,
        actual: "both selector and text supplied",
      },
    };
  }
  if (!opts.selector && !opts.text) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind: "count",
        expected: `one of selector / text`,
        actual: "neither selector nor text supplied",
      },
    };
  }
  const target = opts.selector ?? `text:${opts.text}`;
  const expected = `count === ${opts.n} matching ${target}`;
  try {
    let actualCount: number;
    if (opts.selector) {
      actualCount = await page.locator(opts.selector).count();
    } else {
      // Visible-text path: walk the composed a11y tree, count nodes whose
      // trimmed name matches `text` case-insensitively (text_search-style).
      const { tree } = await composeSnapshot(cdp, refs, opts.testAttributes);
      if (!tree) actualCount = 0;
      else actualCount = searchTreeForText(tree, opts.text!, false, 1000).length;
    }
    if (actualCount === opts.n) return { ok: true };
    return {
      ok: false,
      failure: {
        source: "app",
        kind: "count",
        expected,
        actual: actualCount,
        evidence: { matching: target },
      },
    };
  } catch (e) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind: "count",
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

/**
 * Evaluate a fixed-vocabulary `Predicate` against caller-supplied data
 * (typically an `ActionResult` + optional companion `snapshot` / `evidence`).
 *
 * NOT arbitrary JS: the engine accepts only `kind` values from the
 * `Predicate` enum and `key` accessor strings starting with an allow-listed
 * root segment. Adopters supply *data* (which key, which expected value);
 * the *vocabulary* is owned server-side. See `src/util/predicates.ts`.
 */
export function verifyPredicate(predicate: Predicate, data: unknown): VerifyResult {
  const shapeError = validatePredicate(predicate);
  if (shapeError) {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind: "predicate-shape",
        expected: "well-formed Predicate",
        actual: shapeError,
      },
    };
  }
  const res: PredicateResult = evaluatePredicate(predicate, data);
  if (res.ok) return { ok: true };
  return {
    ok: false,
    failure: {
      source: "app",
      kind: res.kind,
      expected: res.expected,
      actual: res.actual,
      ...(res.key !== undefined ? { evidence: { key: res.key } } : {}),
    },
  };
}

// Re-export the page/snapshot-walking helpers other call sites may want when
// composing custom `verify_predicate` data bags. Keeps `verify.ts` the single
// import surface for verify-family work.
export { findByRef, walk, visibleRect };
