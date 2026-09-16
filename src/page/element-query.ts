// `ActionTarget` → `ElementQuery`. The one conversion between the agent-facing
// target vocabulary (`ref` / `selector` / `coords`, what a tool's `asTarget`
// produces) and the element port's own (`ref` / `selector` / `expression`).
//
// It is a separate leaf, not a member of either, because both sides would be
// wrong homes: `element-substrate-types.ts` is the port and must name only its
// own vocabulary, and `locator.ts` is the Playwright resolution body. A plain-data
// leaf lets `verify-types.ts` and `gestures.ts` convert without importing either.
//
// `coords` returns null rather than throwing: a pixel is not an element, every
// caller already has a branch for it, and the failure text that branch emits
// differs per caller (`verify_*` says "coords target", `gestures` resolves the
// point directly). (RFC 0009 P2.)

import type { ActionTarget } from "./actions-types.js";
import type { ElementQuery } from "./element-substrate-types.js";

/** The message `locatorFor` has always thrown for a target carrying none of
 *  `ref` / `selector` / `coords`. Shared so the port path and the direct
 *  `locatorFor` path report the same sentence — it reaches the agent as
 *  `failure.actual` on the verify family. */
export const TARGET_SHAPE_ERROR =
  "locatorFor: requires { ref } or { selector } (with optional { contextRef } for scoped selectors) or { coords }";

/** The element query for a target, or null when the target names no element
 *  (a `coords` target, or a malformed one carrying nothing at all). */
export function elementQueryFor(target: ActionTarget): ElementQuery | null {
  if (target.ref) return { kind: "ref", ref: target.ref };
  if (target.selector) {
    return target.contextRef !== undefined
      ? { kind: "selector", selector: target.selector, contextRef: target.contextRef }
      : { kind: "selector", selector: target.selector };
  }
  return null;
}
