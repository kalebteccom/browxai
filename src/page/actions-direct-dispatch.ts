/// <reference lib="dom" />

// The `click({ dispatch: "direct" })` path — measure the target in ONE page-side
// call, then push the pointer sequence at those coordinates through CDP
// `Input.dispatchMouseEvent`.
//
// `force: true` is not this. Force skips the actionability checks, but Playwright
// still RESOLVES the element through its locator engine (injected script) and
// scrolls it into view before dispatching, and restarts the whole pointer action
// when the element re-attaches mid-flight. Measured against a view that replaces
// its subtree on a timer while a rAF loop saturates the main thread: the default
// path and the `force: true` recovery both exhaust their budget, and every
// resolution through the locator engine (`boundingBox()`, `locator.evaluate()`)
// lands on a node that has already been detached. A single `page.evaluate` that
// queries AND measures without yielding is the only read that survives, which is
// why this path needs a plain CSS selector rather than a Locator.
//
// CDP feeds the browser's real input pipeline, so the page receives
// pointerdown/mousedown/pointerup/mouseup/click with `isTrusted: true`. Page-side
// `new MouseEvent(...)` cannot: those events are untrusted and any handler that
// reads `isTrusted` drops them silently, which would make this primitive useless
// on exactly the apps it exists for. Hence no page-JS fallback on an engine
// without CDP — it refuses.

import type { CDPSession, Locator, Page } from "playwright-core";
import type { ActionResult, DispatchedAction, ElementProbe, HitPoint } from "./actionresult.js";
import { cssSelectorForTarget, targetDescriptor, type ActionTarget } from "./locator.js";
import type { RefRegistry } from "./refs.js";
import { probe, captureHit } from "./actions-probe.js";

/** How `click` reaches the element. `actionability` (the default) is Playwright's
 *  locator path with the automatic `force: true` recovery; `direct` skips the
 *  locator engine's pre-dispatch path entirely. */
export type ClickDispatch = "actionability" | "direct";

export type MouseButton = "left" | "right" | "middle";

/** CDP `buttons` bitfield: Left=1, Right=2, Middle=4. */
const BUTTONS_MASK: Readonly<Record<MouseButton, number>> = { left: 1, right: 2, middle: 4 };

/** The named refusal reason for `dispatch:"direct"` on an engine with no CDP
 *  escape hatch. */
export const DIRECT_DISPATCH_ENGINE_REFUSAL = "direct-dispatch-needs-cdp";

/** The named refusal reason for a target that only the locator engine can
 *  reach, so there is nothing for the page-side measurement to query. */
export const DIRECT_DISPATCH_TARGET_REFUSAL = "direct-dispatch-needs-css-target";

interface MeasuredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DirectSelector {
  selector: string;
  contextSelector?: string;
}

/** Query and measure in a single page-side call. Splitting the two (resolve a
 *  handle, then measure it) is what fails on a subtree that re-renders between
 *  the two round trips — the handle is already detached and the rect reads
 *  0×0. */
const MEASURE_TARGET_FN = (arg: {
  selector: string;
  contextSelector?: string;
}): MeasuredRect | null => {
  const root: ParentNode | null = arg.contextSelector
    ? document.querySelector(arg.contextSelector)
    : document;
  const el = root ? root.querySelector(arg.selector) : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

function emptyResult(action: DispatchedAction, error: string): ActionResult {
  return {
    ok: false,
    action,
    navigation: { changed: false, from: "", to: "", kind: null },
    structure: { appeared: [], removed: [], newTabs: [] },
    console: { errors: [], warnings: 0 },
    pageErrors: [],
    network: { summary: { total: 0, byType: {}, failed: 0 } },
    tokensEstimate: 0,
    warnings: [],
    error,
  };
}

/** Structured refusal for `dispatch:"direct"` on an engine that cannot serve it.
 *  Emitted by the action substrate before dispatch, so the caller gets a named
 *  reason instead of a silent downgrade to the actionability path. */
export function directDispatchUnsupported(target: ActionTarget, engine: string): ActionResult {
  return emptyResult(
    { type: "click", ...targetDescriptor(target) },
    `${DIRECT_DISPATCH_ENGINE_REFUSAL}: \`click({dispatch:"direct"})\` is not supported on the ` +
      `"${engine}" engine. It dispatches the pointer sequence through CDP ` +
      `Input.dispatchMouseEvent so the page receives TRUSTED events, and that escape hatch ` +
      `exists only on chromium-family engines. Synthesising the events in page JS instead ` +
      `would produce isTrusted:false events that framework handlers drop silently, so there ` +
      `is no fallback here. Open a chromium session for this click, or omit \`dispatch\` — ` +
      `the default path (including its automatic \`force: true\` recovery) runs on every engine.`,
  );
}

/** Resolve the target to the CSS selector (plus optional scoping selector) the
 *  page-side measurement queries with. Null when the target is only reachable
 *  through the locator engine, or lives in a child frame — an iframe's
 *  `getBoundingClientRect()` is frame-relative while CDP dispatches in main-frame
 *  viewport coordinates, so aiming there would click the wrong place. */
function directSelector(refs: RefRegistry, target: ActionTarget): DirectSelector | null {
  if (target.ref && refs.frameOf(target.ref)) return null;
  const selector = cssSelectorForTarget(refs, target);
  if (!selector) return null;
  if (!target.contextRef) return { selector };
  const contextSelector = cssSelectorForTarget(refs, { ref: target.contextRef });
  return contextSelector ? { selector, contextSelector } : null;
}

function unaddressable(target: ActionTarget): Error {
  return new Error(
    `${DIRECT_DISPATCH_TARGET_REFUSAL}: \`dispatch:"direct"\` measures the target with a plain ` +
      "CSS query in the page, and this target has no CSS form — it is a role/name-only ref, a " +
      "`named` binding to one, or a ref minted inside a child frame (whose coordinates are " +
      "frame-relative, so dispatching there would click the wrong place). Pass a `selector`, " +
      "re-`find()` a target that carries a test attribute, or drop `dispatch` and let the " +
      "default path resolve it through the locator engine. Frame targets are not supported " +
      `by this mode at all: ${JSON.stringify(targetDescriptor(target))}`,
  );
}

function noRenderedBox(sel: DirectSelector): Error {
  return new Error(
    `${DIRECT_DISPATCH_TARGET_REFUSAL}: \`dispatch:"direct"\` aims at the target's box centre ` +
      `and "${sel.selector}"${sel.contextSelector ? ` inside "${sel.contextSelector}"` : ""} ` +
      "matched nothing with a rendered box (absent, display:none, or zero-sized) at the moment " +
      "it was measured. This mode resolves ONCE by design and does not retry: re-`find()` the " +
      "target, or drop `dispatch` so the default path waits for it.",
  );
}

async function dispatchPointerSequence(
  cdp: CDPSession,
  point: { x: number; y: number },
  button: MouseButton,
): Promise<void> {
  const common = { x: point.x, y: point.y, pointerType: "mouse" } as const;
  // Written back-to-back and awaited together, not awaited one at a time: a CDP
  // round trip between mousePressed and mouseReleased is long enough for a
  // re-rendering subtree to replace the pressed node, and the browser then fires
  // NO `click` at all — the two targets have no connected common ancestor. The
  // session preserves command order, so batching them is what keeps the whole
  // sequence inside one render generation.
  await Promise.all([
    cdp.send("Input.dispatchMouseEvent", {
      ...common,
      type: "mouseMoved",
      button: "none",
      buttons: 0,
      clickCount: 0,
    }),
    cdp.send("Input.dispatchMouseEvent", {
      ...common,
      type: "mousePressed",
      button,
      buttons: BUTTONS_MASK[button],
      clickCount: 1,
    }),
    cdp.send("Input.dispatchMouseEvent", {
      ...common,
      type: "mouseReleased",
      button,
      buttons: 0,
      clickCount: 1,
    }),
  ]);
}

function describeHit(hit: HitPoint | null): string {
  if (!hit) return "nothing (no element at that point, or the point is outside the viewport)";
  const role = hit.role ? ` role=${hit.role}` : "";
  const text = hit.text ? ` "${hit.text}"` : "";
  return `<${hit.tag}${role}>${text}`;
}

function directDispatchWarning(point: { x: number; y: number }, hit: HitPoint | null): string {
  return (
    `click: dispatch:"direct" — measured the target once, then dispatched ` +
    `pointerdown/mousedown/pointerup/mouseup/click through CDP at ` +
    `(${Math.round(point.x)}, ${Math.round(point.y)}), skipping Playwright's locator ` +
    `resolution, actionability checks, scroll-into-view and mousedown hit-target interceptor. ` +
    `The events are TRUSTED (isTrusted:true). NO visibility / stability / enabled / ` +
    `receives-events guarantee was made for you: elementFromPoint at that coordinate was ` +
    `${describeHit(hit)} — compare it against the target you meant, and read \`element.hit\` ` +
    `for the before/after evidence. The browser still hit-tests the coordinate, so an overlay ` +
    `on top of the target receives the click instead of it, and a \`disabled\` control still ` +
    `fires nothing. This mode does not scroll: a target outside the viewport is not clicked.`
  );
}

/**
 * Measure the target once, dispatch the click at its box centre, and probe what
 * happened. Returns the post-action probe carrying the coordinate evidence and
 * the mandatory bypass warning; `runInActionWindow` splices both onto the result
 * and turns a throw here into `ok:false` with the message.
 */
export async function directClick(
  page: Page,
  cdp: CDPSession,
  loc: Locator,
  args: {
    target: ActionTarget;
    refs: RefRegistry;
    button?: MouseButton;
  },
): Promise<ElementProbe> {
  const sel = directSelector(args.refs, args.target);
  if (!sel) throw unaddressable(args.target);
  const rect = await page.evaluate(MEASURE_TARGET_FN, sel);
  if (!rect) throw noRenderedBox(sel);
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const hitBefore = await captureHit(page, point.x, point.y);
  await dispatchPointerSequence(cdp, point, args.button ?? "left");
  const probed = await probe(loc, args.target);
  probed.hit = { before: hitBefore, after: await captureHit(page, point.x, point.y) };
  probed.warnings = [directDispatchWarning(point, hitBefore)];
  return probed;
}
