// The ref → Playwright `Frame` binding.
//
// A child-frame ref has to remember which frame it was minted in, so
// action-time locator resolution routes through `frame.locator(...)` instead of
// `page.locator(...)` and the action lands inside the right OOPIF. That binding
// used to live on `RefRegistry` as a `Map<string, Frame>` field, which made the
// registry — the engine-blind ref vocabulary every substrate port passes across
// the seam — name a Playwright type. A port that reaches playwright-core is not
// a port (RFC 0009; the `ports-name-no-vendor-type` rule).
//
// So the binding lives here instead, in a Playwright-named module, as a side
// table keyed on the registry instance. Every reader and writer is already
// Playwright adapter code: `compose.ts` / `dom-walk.ts` bind while walking a
// child frame, `locator.ts` / `actions-direct-dispatch.ts` read at dispatch.
// The `WeakMap` ties the table's lifetime to the registry's, so a discarded
// session's frame handles are collectable exactly as they were when the map was
// a registry field.
//
// A second engine binds nothing: Safari resolves refs through WebDriver element
// ids and never calls in here, which is the point of taking the type off the
// registry. When the frame tools get their own port (RFC 0009's open question),
// this table is what that port replaces.

import type { Frame } from "playwright-core";
import type { RefRegistry } from "./refs.js";

const frameByRef = new WeakMap<RefRegistry, Map<string, Frame>>();

/** Bind a Playwright Frame handle to a ref. Call when minting a ref in a
 *  child-frame snapshot/find so action-time `locatorFor` can route through the
 *  frame instead of the page. Main-frame refs don't need to call this; absence
 *  of a binding means "resolve through the page". Unknown refs are ignored,
 *  which is the guard the registry field carried. */
export function bindRefFrame(refs: RefRegistry, ref: string, frame: Frame): void {
  if (!refs.has(ref)) return;
  let table = frameByRef.get(refs);
  if (!table) {
    table = new Map<string, Frame>();
    frameByRef.set(refs, table);
  }
  table.set(ref, frame);
}

/** Resolve a ref to its bound Frame, or undefined for main-frame refs. */
export function refFrameOf(refs: RefRegistry, ref: string): Frame | undefined {
  return frameByRef.get(refs)?.get(ref);
}
