// Pointer-gesture primitives — capability `action`.
//
// `click`/`hover` cover taps; media editors and drag-reorder UIs also need
// drag, double-click, and raw mouse down/move/up.

import type { CDPSession, Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { locatorFor, type ActionTarget } from "./locator.js";
import { pointProbe, type PointProbeResult } from "./point_probe.js";

export interface Point { x: number; y: number }

/** Resolve an action target to a viewport point — the element's box centre
 *  for ref/selector, or the literal coords. */
export async function targetPoint(page: Page, refs: RefRegistry, t: ActionTarget): Promise<Point> {
  if (t.coords) return { x: t.coords.x, y: t.coords.y };
  const box = await locatorFor(page, refs, t).boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("drag/gesture target has no rendered box");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export interface DragResult { ok: boolean; from: Point; to: Point; steps: number }

export interface DragPreflight {
  ok: boolean;
  preflight: {
    point: Point;
    hit: PointProbeResult;
    /** true when something under the press point looks like a resize handle
     *  (a `*-resize` cursor) — dragging here is likely to resize, not move. */
    resizeRisk: boolean;
  };
}

const RESIZE_CURSOR = /resize/i;

/** Press at `from`, move to `to` over `steps` intermediate points, release.
 *  With `preflight: true`, instead probe the `from` point and report what's
 *  under it (top hit element + resize-handle risk) WITHOUT dragging — so the
 *  agent can confirm the press lands on draggable content, not a resize
 *  handle, before committing. Element targets resolve to the box centre. */
export async function drag(
  page: Page,
  refs: RefRegistry,
  args: { from: ActionTarget; to: ActionTarget; steps?: number; preflight?: boolean },
): Promise<DragResult | DragPreflight> {
  const from = await targetPoint(page, refs, args.from);
  if (args.preflight) {
    const hit = await pointProbe(page, from);
    const resizeRisk = hit.stack.some((el) => RESIZE_CURSOR.test(el.cursor || ""));
    return { ok: true, preflight: { point: from, hit, resizeRisk } };
  }
  const steps = Math.min(Math.max(args.steps ?? 12, 1), 100);
  const to = await targetPoint(page, refs, args.to);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  return { ok: true, from, to, steps };
}

export interface DoubleClickResult { ok: boolean; point: Point }

export async function doubleClick(
  page: Page,
  refs: RefRegistry,
  target: ActionTarget,
): Promise<DoubleClickResult> {
  const point = await targetPoint(page, refs, target);
  await page.mouse.dblclick(point.x, point.y);
  return { ok: true, point };
}

/** Coordinate-space wheel event — for canvas / virtualised lists / map tiles
 *  that listen for `wheel` and ignore Playwright's element-level scroll.
 *  Dispatched via CDP `Input.dispatchMouseEvent` (`type: "mouseWheel"`) so the
 *  event fires at `coords` regardless of the current pointer position, with
 *  the caller's `deltaX`/`deltaY` (CSS px; positive Y scrolls content up,
 *  matching the DOM `WheelEvent` convention). One of `deltaX`/`deltaY` must be
 *  non-zero. */
export async function mouseWheel(
  cdp: CDPSession,
  args: { coords: Point; deltaX?: number; deltaY?: number },
): Promise<{ ok: boolean; coords: Point; deltaX: number; deltaY: number }> {
  const deltaX = args.deltaX ?? 0;
  const deltaY = args.deltaY ?? 0;
  if (deltaX === 0 && deltaY === 0) {
    throw new Error("mouse_wheel requires non-zero deltaX or deltaY");
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: args.coords.x,
    y: args.coords.y,
    deltaX,
    deltaY,
    button: "none",
    pointerType: "mouse",
  });
  return { ok: true, coords: args.coords, deltaX, deltaY };
}

export type MouseAction = "down" | "move" | "up";

/** Low-level mouse control for gestures the higher-level tools don't cover
 *  (custom scrub/trim handles). `move` requires coords; `down`/`up` move
 *  there first when coords are given, else act at the current position. */
export async function mouseAction(
  page: Page,
  action: MouseAction,
  coords?: Point,
): Promise<{ ok: boolean; action: MouseAction; coords?: Point }> {
  if (action === "move") {
    if (!coords) throw new Error("mouse_move requires coords");
    await page.mouse.move(coords.x, coords.y);
  } else {
    if (coords) await page.mouse.move(coords.x, coords.y);
    if (action === "down") await page.mouse.down();
    else await page.mouse.up();
  }
  return { ok: true, action, ...(coords ? { coords } : {}) };
}

// ---------- Touch primitives ----------
//
// CDP `Input.dispatchTouchEvent` is the touch sibling of `dispatchMouseEvent`.
// It accepts a `type` (`touchStart` / `touchMove` / `touchEnd` / `touchCancel`)
// and a `touchPoints[]` array — each point carries `{x, y, id?}`. The `id`
// field is what TouchEvent.changedTouches[].identifier ends up as on the page
// side; that's how a JS handler distinguishes finger #1 from finger #2 across
// a multi-touch sequence. We expose it as `identifier` on our API to match
// the DOM-side vocabulary.
//
// Touch events do NOT fire mouse events automatically. Browsers MAY synthesize
// `mousedown`/`mouseup`/`click` from a touchend on touch-aware pages, but that
// behaviour is app-policy (touch-action, preventDefault choices) — an agent
// that needs both pipelines should dispatch both explicitly.

export type TouchAction = "start" | "move" | "end";

const TOUCH_CDP_TYPE: Record<TouchAction, "touchStart" | "touchMove" | "touchEnd"> = {
  start: "touchStart",
  move: "touchMove",
  end: "touchEnd",
};

/** Dispatch a single touch event at `coords` via CDP. `identifier` tracks the
 *  finger across a multi-touch sequence (default `1`). `touch_end` accepts
 *  optional `coords`; when omitted CDP gets an empty `touchPoints[]` — the
 *  spec's "all fingers up" form. */
export async function touchAction(
  cdp: CDPSession,
  action: TouchAction,
  args: { coords?: Point; identifier?: number },
): Promise<{ ok: boolean; action: TouchAction; coords?: Point; identifier: number }> {
  const identifier = args.identifier ?? 1;
  if (action !== "end" && !args.coords) {
    throw new Error(`touch_${action} requires coords`);
  }
  const touchPoints = args.coords
    ? [{ x: args.coords.x, y: args.coords.y, id: identifier }]
    : [];
  await cdp.send("Input.dispatchTouchEvent", {
    type: TOUCH_CDP_TYPE[action],
    touchPoints,
  });
  return {
    ok: true,
    action,
    ...(args.coords ? { coords: args.coords } : {}),
    identifier,
  };
}

export interface GesturePinchResult {
  ok: boolean;
  coords: Point;
  scale: number;
  steps: number;
  startOffset: number;
  endOffset: number;
}

/** Two-finger pinch in/out, centred on `coords`. Two touch points start at
 *  `coords ± startOffset` (a fixed 40 CSS px each side — wider than any
 *  realistic finger pair but small enough to land inside a typical canvas) and
 *  converge or diverge so the final separation = startOffset × scale.
 *  `scale < 1` is pinch-in (zoom out); `scale > 1` is pinch-out (zoom in).
 *  Linear interpolation across `steps` intermediate `touchMove` dispatches —
 *  pinch handlers (Hammer.js, GoogleMaps, Figma) read the delta between
 *  successive `changedTouches`, so a linear ramp is sufficient and avoids the
 *  velocity-detection misfires a sinusoidal curve can trigger on fling-detect
 *  libraries. */
export async function gesturePinch(
  cdp: CDPSession,
  args: { coords: Point; scale: number; steps?: number; startOffset?: number },
): Promise<GesturePinchResult> {
  const scale = args.scale;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("gesture_pinch requires a positive finite scale");
  }
  const steps = Math.min(Math.max(args.steps ?? 12, 1), 100);
  const startOffset = args.startOffset ?? 40;
  const endOffset = startOffset * scale;
  const cx = args.coords.x;
  const cy = args.coords.y;
  const id1 = 1;
  const id2 = 2;

  // touchStart with both fingers
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: cx - startOffset, y: cy, id: id1 },
      { x: cx + startOffset, y: cy, id: id2 },
    ],
  });

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const offset = startOffset + (endOffset - startOffset) * t;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: cx - offset, y: cy, id: id1 },
        { x: cx + offset, y: cy, id: id2 },
      ],
    });
  }

  // touchEnd lifts all fingers (empty touchPoints[])
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  return { ok: true, coords: args.coords, scale, steps, startOffset, endOffset };
}

export interface GestureSwipeResult {
  ok: boolean;
  from: Point;
  to: Point;
  steps: number;
  durationMs: number;
}

/** Single-finger swipe from `from` to `to`. Distinct from `drag` — drag uses
 *  the mouse pipeline; swipe uses the touch pipeline. `durationMs` controls
 *  pacing (default 200 ms — fast flick; 500+ ms reads as a deliberate scroll).
 *  Smoothed via an ease-out curve (`1 - (1-t)²`) — touch libraries derive
 *  velocity from per-frame deltas; ease-out matches the natural deceleration
 *  most fling-detect heuristics are tuned for (Hammer.js, native scroll
 *  inertia, react-spring-style physics). */
export async function gestureSwipe(
  cdp: CDPSession,
  args: { from: Point; to: Point; durationMs?: number; steps?: number; identifier?: number },
): Promise<GestureSwipeResult> {
  const identifier = args.identifier ?? 1;
  const durationMs = Math.min(Math.max(args.durationMs ?? 200, 0), 60_000);
  const steps = Math.min(Math.max(args.steps ?? 16, 1), 200);

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: args.from.x, y: args.from.y, id: identifier }],
  });

  const dx = args.to.x - args.from.x;
  const dy = args.to.y - args.from.y;
  const perStepDelay = durationMs / steps;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-out: 1 - (1 - t)^2 — fast start, gentle settle
    const eased = 1 - (1 - t) * (1 - t);
    const x = args.from.x + dx * eased;
    const y = args.from.y + dy * eased;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: identifier }],
    });
    if (perStepDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, perStepDelay));
    }
  }

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  return { ok: true, from: args.from, to: args.to, steps, durationMs };
}
