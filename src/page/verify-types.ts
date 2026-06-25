// Shared `verify_*` resolve/fail vocabulary — the engine-blind result shapes
// (`VerifyResult` / `VerifyFailure` / `FailureSource`) plus the one CDP-light
// `resolveOrFail` helper every element-bound verify funnels through. Split out
// of verify.ts so the count/predicate verifies and the element verifies can
// each import this leaf without one pulling in the other; re-exported through
// `./verify.js`.
//
// A failed verify always emits a structured `{source:"app", expected, actual}`
// failure, never a warning the LLM has to eyeball. Each helper returns one of:
//   { ok: true }
//   { ok: false, failure: { source, kind, expected, actual, evidence? } }

import type { Locator, Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { locatorFor, type ActionTarget } from "./locator.js";
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
export function resolveOrFail(
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
