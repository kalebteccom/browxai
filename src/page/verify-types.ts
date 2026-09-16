// Shared `verify_*` resolve/fail vocabulary — the engine-blind result shapes
// (`VerifyResult` / `VerifyFailure` / `FailureSource`) plus the two mappers every
// element-bound verify funnels through: `resolveOrFail` (an `ActionTarget` to an
// `ElementToken`) and `refusalFailure` (an `ElementRefusal` to a `VerifyFailure`).
// Split out of verify.ts so the count/predicate verifies and the element verifies
// can each import this leaf without one pulling in the other; re-exported through
// `./verify.js`.
//
// A failed verify always emits a structured `{source:"app", expected, actual}`
// failure, never a warning the LLM has to eyeball. Each helper returns one of:
//   { ok: true }
//   { ok: false, failure: { source, kind, expected, actual, evidence? } }
//
// THE SOURCE SPLIT IS THE WEBDRIVER SPLIT, and until RFC 0009 P2 it was two
// hand-written strings rather than one fact. `source:"browxai"` with "ref no
// longer in the snapshot" meant the registry never had the reference; `source:
// "app"` with "missing (locator matched 0 nodes)" meant the registry has it and
// the page does not. W3C WebDriver names those `no such element` and `stale
// element reference` and keeps them apart deliberately, because an agent does
// different things in each case: re-find, or re-snapshot. `ElementSubstrate` now
// classifies them at the port, both engines report the same two, and the two
// strings below are the rendering rather than the distinction itself.
//
// This module reaches no Playwright type. Resolution goes through the element
// port, so the verify family no longer needs a `Page` and runs on any engine that
// declares the `element` sub-interface. (RFC 0009 P2.)

import { elementQueryFor, TARGET_SHAPE_ERROR } from "./element-query.js";
import type { ActionTarget } from "./actions-types.js";
import type { ElementRefusal, ElementSubstrate, ElementToken } from "./element-substrate-types.js";
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

/** Render an element-port refusal as a verify failure.
 *
 *  `stale-element` is the ONLY one that is an `app` failure: the reference is
 *  live and the page holds no node for it, which is a true statement about the
 *  application. Everything else is `browxai` — the check did not run, and a
 *  human signing off a QA report must be able to tell the two apart. Both strings
 *  are the ones these paths emitted before the port existed. */
export function refusalFailure(
  refusal: ElementRefusal,
  kind: string,
  expected: string,
): { ok: false; failure: VerifyFailure } {
  if (refusal.reason === "stale-element") {
    return {
      ok: false,
      failure: { source: "app", kind, expected, actual: "missing (locator matched 0 nodes)" },
    };
  }
  if (refusal.reason === "no-such-element") {
    return {
      ok: false,
      failure: {
        source: "browxai",
        kind,
        expected,
        actual: "ref no longer in the snapshot",
        evidence: {
          ...(refusal.ref !== undefined ? { ref: refusal.ref } : {}),
          hint: "call snapshot() or find() again — the page may have re-rendered",
        },
      },
    };
  }
  return { ok: false, failure: { source: "browxai", kind, expected, actual: refusal.error } };
}

/** Resolve an `ActionTarget` to an element token through the port, failing-emitting
 *  (`source:"browxai"`) when the target names no element or the reference is gone. */
export async function resolveOrFail(
  elements: ElementSubstrate,
  target: ActionTarget,
  kind: string,
  expected: string,
): Promise<{ ok: true; el: ElementToken; ref?: string } | { ok: false; failure: VerifyFailure }> {
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
  const query = elementQueryFor(target);
  if (!query) {
    return {
      ok: false,
      failure: { source: "browxai", kind, expected, actual: TARGET_SHAPE_ERROR },
    };
  }
  const resolved = await elements.resolve(query);
  if (resolved.kind === "refusal") return refusalFailure(resolved, kind, expected);
  return { ok: true, el: resolved.el, ...(target.ref ? { ref: target.ref } : {}) };
}
