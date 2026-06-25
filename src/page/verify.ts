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
//
// This module keeps the count/predicate verifies and stays the single import
// surface for verify-family work: the shared resolve/fail vocabulary lives in
// `./verify-types.js` and the element-bound verifies in `./verify-element.js`,
// both re-exported below.

import type { Page, CDPSession } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { composeSnapshot } from "./compose.js";
import { findByRef } from "./snapshot.js";
import { searchTreeForText } from "./text_search.js";
import { walk } from "./a11y.js";
import { visibleRect } from "./bbox.js";
import {
  evaluatePredicate,
  validatePredicate,
  type Predicate,
  type PredicateResult,
} from "../util/predicates.js";
import type { VerifyResult } from "./verify-types.js";

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

// Re-export the shared resolve/fail vocabulary and the element-bound verifies so
// `verify.ts` stays the single import surface for verify-family work.
export {
  resolveOrFail,
  type FailureSource,
  type VerifyFailure,
  type VerifyResult,
} from "./verify-types.js";
export { verifyVisible, verifyText, verifyValue, verifyAttribute } from "./verify-element.js";

// Re-export the page/snapshot-walking helpers other call sites may want when
// composing custom `verify_predicate` data bags. Keeps `verify.ts` the single
// import surface for verify-family work.
export { findByRef, walk, visibleRect };
