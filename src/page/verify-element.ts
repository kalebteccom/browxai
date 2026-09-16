// Element-bound `verify_*` helpers — visible / text / value / attribute. Each
// resolves a single `ActionTarget` to an `ElementToken` (via the shared
// `resolveOrFail` in `./verify-types.js`), reads one piece of element state
// through `ElementSubstrate.probe`, and emits the structured pass/fail result.
// Split out of verify.ts so the per-element assertions live apart from the
// count/predicate verifies; re-exported through `./verify.js`.
//
// All four share the same reference-gone shape, and it is TWO shapes, not one:
// `source:"browxai"` / "ref no longer in the snapshot" when the registry never
// held the reference, `source:"app"` / "missing (locator matched 0 nodes)" when it
// does and the page has no node for it. Those are WebDriver's `no such element`
// and `stale element reference`; `refusalFailure` renders them from the port's
// classification rather than from a hand-written check per helper.
//
// NO PLAYWRIGHT TYPE AND NO `Page`. Before RFC 0009 P2 each helper took a `Page`,
// built a `Locator` and chained `.count()` / `.isVisible()` / `.innerText()` /
// `.evaluate()` / `.getAttribute()` on it, so the whole family was Playwright-only
// and `verify_visible` on a Safari session reported the engine's own refusal as a
// FAILED ASSERTION in the QA-evidence surface. Every read is now one batched
// `probe` call, with the same number of round trips: the port takes the match
// count and the reading in one request, which is what the single `probe` member
// exists for.

import type { ActionTarget } from "./actions-types.js";
import type { ElementSubstrate } from "./element-substrate-types.js";
import { refusalFailure, resolveOrFail, type VerifyResult } from "./verify-types.js";

/** Verify that the targeted element is visible (non-zero box, not
 *  display:none/visibility:hidden, opacity > 0). `source:"app"` on miss. */
export async function verifyVisible(
  elements: ElementSubstrate,
  target: ActionTarget,
): Promise<VerifyResult> {
  const expected = "visible (non-zero box, displayed, opacity > 0)";
  const resolved = await resolveOrFail(elements, target, "visible", expected);
  if (!resolved.ok) return resolved;
  // `notVisibleReason` is requested alongside, and the port only spends the
  // second round trip on it when the element actually reports not-visible —
  // identical to the old `probeNotVisibleReason(loc.first())` call site.
  const read = await elements.probe(resolved.el, {
    matches: true,
    visible: true,
    notVisibleReason: true,
  });
  if (read.kind === "refusal") return refusalFailure(read, "visible", expected);
  // A read that could not run is `browxai`, never a false assertion: the old body
  // left `isVisible()` uncaught inside the outer try for exactly this reason.
  if (read.failures?.visible !== undefined) {
    return {
      ok: false,
      failure: { source: "browxai", kind: "visible", expected, actual: read.failures.visible },
    };
  }
  if (read.visible === true) return { ok: true };
  return {
    ok: false,
    failure: {
      source: "app",
      kind: "visible",
      expected,
      actual: read.notVisibleReason ?? "hidden",
    },
  };
}

/** Verify that the targeted element's visible text matches. `exact:true` →
 *  case-sensitive equality on the trimmed innerText. Default → case-insensitive
 *  substring. `source:"app"` on miss. */
export async function verifyText(
  elements: ElementSubstrate,
  target: ActionTarget,
  text: string,
  exact: boolean,
): Promise<VerifyResult> {
  const expected = exact
    ? `text === ${JSON.stringify(text)}`
    : `text includes ${JSON.stringify(text)}`;
  const resolved = await resolveOrFail(elements, target, "text", expected);
  if (!resolved.ok) return resolved;
  const read = await elements.probe(resolved.el, { matches: true, text: true });
  if (read.kind === "refusal") return refusalFailure(read, "text", expected);
  // A text read that failed comes back `null` and is treated as empty — the old
  // body's `innerText().catch(() => null) ?? ""`, preserved deliberately: an
  // element with no text and an element whose text could not be read were already
  // the same answer here.
  const trimmed = (read.text ?? "").trim();
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
}

/** Verify that the targeted input/textarea/contenteditable carries the given
 *  value (strict equality after a defensive `String()`). `source:"app"` on
 *  miss. */
export async function verifyValue(
  elements: ElementSubstrate,
  target: ActionTarget,
  value: string,
): Promise<VerifyResult> {
  const expected = `value === ${JSON.stringify(value)}`;
  const resolved = await resolveOrFail(elements, target, "value", expected);
  if (!resolved.ok) return resolved;
  const read = await elements.probe(resolved.el, { matches: true, value: true });
  if (read.kind === "refusal") return refusalFailure(read, "value", expected);
  const actual = read.value ?? null;
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
    failure: { source: "app", kind: "value", expected, actual: String(actual).slice(0, 200) },
  };
}

/** Verify that the targeted element's `attr` attribute equals `value`. When
 *  `value` is undefined, this asserts the attribute is present (any value).
 *  `source:"app"` on miss. */
export async function verifyAttribute(
  elements: ElementSubstrate,
  target: ActionTarget,
  attr: string,
  value: string | undefined,
): Promise<VerifyResult> {
  const expected =
    value === undefined
      ? `attribute "${attr}" is present`
      : `attribute "${attr}" === ${JSON.stringify(value)}`;
  const resolved = await resolveOrFail(elements, target, "attribute", expected);
  if (!resolved.ok) return resolved;
  const read = await elements.probe(resolved.el, { matches: true, attribute: attr });
  if (read.kind === "refusal") return refusalFailure(read, "attribute", expected);
  const actual = read.attribute ?? null;
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
    failure: { source: "app", kind: "attribute", expected, actual, evidence: { attr } },
  };
}
