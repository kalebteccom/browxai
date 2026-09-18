// Scroll and the three gesture primitives on the ios-app engine.
//
// XCUITest exposes swipe and pinch as PRIMITIVES —
// `dragFromToForDuration` and `XCUIElement.pinch(withScale:velocity:)` — which is
// the reason `ActionSubstrate.gesture` takes a closed union of three request
// kinds rather than a single `touch` member (the header of `gesture-types.ts`
// says so). A port naming only `touch` would force this adapter to synthesise a
// swipe from touch events, which is the opposite of what the platform offers.
//
// The raw touch pipeline is the one that REFUSES, and that is the honest way
// round. XCUITest has no touch-down / touch-move / touch-up API: it has taps,
// drags, presses and pinches. Synthesising one from the others would report a
// `touch_start` that never happened.

import type { NativeSessionHandle, NativePoint } from "../engine/native-types.js";
import type { ActionResult } from "./actionresult-types.js";
import type * as actions from "./actions-types.js";
import type { GestureRequest, GestureResult } from "./gesture-types.js";
import { iosResult, iosUnsupported } from "./ios-actions.js";

/** How far a one-shot scroll travels, as a fraction of the screen. Two thirds is
 *  what a user's thumb does and it leaves an overlap the reader can anchor on;
 *  a full-height swipe skips content. */
const SCROLL_FRACTION = 2 / 3;
/** A scroll-to-edge is repeated swipes — XCUITest has no "scroll to end". The cap
 *  bounds the work (L7) and is reported when it is reached, so "I stopped at the
 *  cap" never reads as "I reached the edge". */
const EDGE_SWIPES = 8;
const SWIPE_MS = 300;

/** The screen rectangle, read from the hierarchy root. Asking the tree rather
 *  than assuming a device size keeps this correct across iPhone, iPad and a
 *  rotated device. */
async function screenSize(handle: NativeSessionHandle): Promise<{ width: number; height: number }> {
  const root = await handle.driver.hierarchy();
  return { width: root.rect.width, height: root.rect.height };
}

/** The from/to pair for one scroll swipe. Scrolling DOWN means dragging the
 *  content UP, which is the inversion every touch surface has and the one place
 *  a sign error would silently scroll the wrong way. */
function swipePath(
  screen: { width: number; height: number },
  dx: number,
  dy: number,
): { from: NativePoint; to: NativePoint } {
  const cx = Math.round(screen.width / 2);
  const cy = Math.round(screen.height / 2);
  const reach = Math.round((dy !== 0 ? screen.height : screen.width) * SCROLL_FRACTION) / 2;
  const unitX = dx === 0 ? 0 : Math.sign(dx);
  const unitY = dy === 0 ? 0 : Math.sign(dy);
  return {
    from: { x: Math.round(cx + unitX * reach), y: Math.round(cy + unitY * reach) },
    to: { x: Math.round(cx - unitX * reach), y: Math.round(cy - unitY * reach) },
  };
}

export async function iosScroll(
  handle: NativeSessionHandle,
  args: actions.ScrollArgs,
): Promise<ActionResult> {
  if (args.target && args.intoView !== false && !args.to && !args.by) {
    return iosUnsupported(
      "scroll",
      "scrolling an element INTO VIEW needs a container-aware scroll XCUITest does not expose " +
        "through this driver. Scroll the screen with `by` or `to`, re-snapshot, and act on the " +
        "element once it is in the hierarchy with a non-zero frame.",
    );
  }
  const screen = await screenSize(handle);
  const repeats = args.to ? EDGE_SWIPES : 1;
  const { dx, dy } = directionOf(args);
  if (dx === 0 && dy === 0) {
    return iosUnsupported("scroll", "the request names no direction — pass `by` or `to`.");
  }
  const path = swipePath(screen, dx, dy);
  for (let i = 0; i < repeats; i++) {
    await handle.driver.swipe(path.from, path.to, SWIPE_MS);
  }
  return iosResult({ type: "scroll" }, true, {
    warnings: args.to
      ? [
          `\`to: "${args.to}"\` was performed as ${EDGE_SWIPES} swipes — XCUITest has no ` +
            "scroll-to-end primitive, so this is a bounded best effort and may not have reached " +
            "the edge. Re-snapshot to see where it stopped.",
        ]
      : undefined,
  });
}

/** The scroll direction as a unit vector. `by` is the wheel-style delta the
 *  handler builds from `direction`; `to` is an edge. */
function directionOf(args: actions.ScrollArgs): { dx: number; dy: number } {
  if (args.to) {
    return {
      dx: args.to === "right" ? 1 : args.to === "left" ? -1 : 0,
      dy: args.to === "bottom" ? 1 : args.to === "top" ? -1 : 0,
    };
  }
  return { dx: args.by?.x ?? 0, dy: args.by?.y ?? 0 };
}

/** XCUITest's pinch velocity, in scale-units per second. 1.0 is what Appium's
 *  XCUITest driver defaults to and it reads as a deliberate two-finger gesture. */
const PINCH_VELOCITY = 1.0;
const DEFAULT_SWIPE_MS = 200;
const DEFAULT_PINCH_OFFSET = 40;

export async function iosGesture(
  handle: NativeSessionHandle,
  req: GestureRequest,
): Promise<GestureResult> {
  switch (req.kind) {
    case "touch":
      return {
        kind: "refusal",
        error: `tool "touch_${req.phase}" is not supported on the "ios-app" engine`,
        engine: "ios-app",
        hint:
          "XCUITest exposes taps, presses, drags and pinches — it has no raw touch-down / " +
          "touch-move / touch-up pipeline, and there is no way to dispatch one. Synthesising the " +
          "phases from a drag would report a `touch_start` that never happened, so this is a " +
          "refusal rather than a degraded result. Use `click` for a tap, `gesture_swipe` for a " +
          "drag (a real XCUITest primitive here) and `gesture_pinch` for a pinch.",
      };
    case "swipe": {
      const durationMs = req.durationMs ?? DEFAULT_SWIPE_MS;
      await handle.driver.swipe(req.from, req.to, durationMs);
      return {
        kind: "dispatched",
        report: {
          ok: true,
          from: req.from,
          to: req.to,
          // XCUITest's drag is ONE primitive with a duration, so there are no
          // intermediate steps to report. Echoing the requested count would be
          // inventing evidence; 1 is what was dispatched.
          steps: 1,
          durationMs,
        },
      };
    }
    case "pinch": {
      await handle.driver.pinch(req.coords, req.scale, PINCH_VELOCITY);
      const startOffset = req.startOffset ?? DEFAULT_PINCH_OFFSET;
      return {
        kind: "dispatched",
        report: {
          ok: true,
          coords: req.coords,
          scale: req.scale,
          steps: 1,
          startOffset,
          endOffset: startOffset * req.scale,
        },
      };
    }
  }
}
