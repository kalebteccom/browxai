// NativeActionSubstrate — the ActionSubstrate implementation over adb's input
// pipeline. `click` is a tap, `press` is a keyevent, `scroll` is a swipe, and
// `gesture` reaches the three primitives the platform actually exposes.
//
// GESTURES ARE PRIMITIVES HERE, NOT SYNTHESISED. RFC 0009 P3 moved touch, swipe
// and pinch behind one `gesture(req)` member with a closed union specifically so
// a native adapter could answer each with its own primitive, and the header of
// `gesture-types.ts` says why: "on a native engine a swipe is a PRIMITIVE, not
// three touch dispatches". That holds for two of the three:
//
//   - `swipe` → `input swipe x1 y1 x2 y2 ms`, one platform call.
//   - `touch` → `input motionevent DOWN|MOVE|UP x y`, one pointer per call,
//     which is the exact shape of `touch_start` / `touch_move` / `touch_end`.
//     Added in API 30; the device refuses below that by name.
//   - `pinch` → REFUSED. There is no two-finger primitive in `adb shell input`,
//     and the ways to fake one are worse than a refusal: two concurrent `input
//     swipe` processes produce two INDEPENDENT pointer-id-0 streams, which an app
//     sees as two unrelated drags rather than a pinch, and `sendevent` against
//     `/dev/input` needs the touchscreen's device node and ABS ranges read per
//     device and is root-only off an emulator. Real multi-touch needs a
//     device-side UiAutomator2 instrumentation server, which is RFC 0008's
//     unresolved "driver integration shape" question and a second binary to ship.
//     A refusal naming that is worth more than a gesture that reports success and
//     did something else.
//
// Dependency direction (architecture doctrine §1): tool handler → ActionSubstrate
// (the port in `action-substrate-types.ts`) → this implementation → adb.

import type { ActionResult } from "./actionresult-types.js";
import type { ActionSubstrate } from "./action-substrate-types.js";
import type * as actions from "./actions-types.js";
import type { ElementSubstrate } from "./element-substrate-types.js";
import type {
  GestureRequest,
  GestureResult,
  PinchRequest,
  SwipeRequest,
  TouchRequest,
} from "./gesture-types.js";
import {
  androidKeyCode,
  descriptorFor,
  nativeResult,
  nativeUnsupportedAction,
  pointFor,
  probeAfter,
} from "./native-actions.js";

/** The device verbs this substrate dispatches. The injected seam is the whole
 *  test strategy: a fake records the argv, and the assertions are on what would
 *  reach the device. */
export interface NativeInputIO {
  tap(x: number, y: number): Promise<void>;
  swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void>;
  motionEvent(phase: "DOWN" | "MOVE" | "UP", x: number, y: number): Promise<void>;
  typeText(value: string): Promise<void>;
  keyEvent(keycode: string): Promise<void>;
  openDeepLink(url: string): Promise<void>;
  screenSize(): Promise<{ width: number; height: number }>;
}

/** Default swipe duration. 300ms reads as a scroll to Android's gesture
 *  detectors; much faster registers as a fling and overshoots, much slower as a
 *  drag and may start a reorder. */
const SCROLL_DURATION_MS = 300;
/** Fraction of the screen one `scroll` moves. */
const SCROLL_FRACTION = 0.6;

export class NativeActionSubstrate implements ActionSubstrate {
  readonly engine: string;

  constructor(
    private readonly io: NativeInputIO,
    private readonly elements: ElementSubstrate,
    engine = "android-app",
  ) {
    this.engine = engine;
  }

  /** `navigate` is a DEEP LINK on a native session. A native screen has no
   *  address bar, so a URL only means anything as an `android.intent.action.VIEW`
   *  intent — which is exactly how a QA flow reaches a screen directly. */
  async navigate(args: actions.NavigateArgs): Promise<ActionResult> {
    const action = { type: "navigate" as const, value: args.url };
    try {
      await this.io.openDeepLink(args.url);
      return nativeResult(action, true);
    } catch (err) {
      return nativeResult(action, false, { error: messageOf(err) });
    }
  }

  /** A tap, at the point a fresh hierarchy read just returned. */
  async click(args: actions.ClickArgs): Promise<ActionResult> {
    const action = descriptorFor("click", args.target);
    const at = await pointFor(this.elements, args.target);
    if ("error" in at) return nativeResult(action, false, { error: at.error });
    try {
      await this.io.tap(at.point.x, at.point.y);
    } catch (err) {
      return nativeResult(action, false, { error: messageOf(err) });
    }
    return nativeResult(action, true, { element: await probeAfter(this.elements, args.target) });
  }

  /** Tap the field to focus it, then type. `input text` goes to whatever holds
   *  focus, so the tap is load-bearing and not a convenience. */
  async fill(args: actions.FillArgs): Promise<ActionResult> {
    const action = { ...descriptorFor("fill", args.target), value: args.value };
    const at = await pointFor(this.elements, args.target);
    if ("error" in at) return nativeResult(action, false, { error: at.error });
    try {
      await this.io.tap(at.point.x, at.point.y);
      await this.io.typeText(args.value);
    } catch (err) {
      return nativeResult(action, false, { error: messageOf(err) });
    }
    const probe = await probeAfter(this.elements, args.target);
    return nativeResult(action, true, {
      element: probe ? { ...probe, valueRequested: args.value } : probe,
      warnings: [
        NATIVE_FILL_SECRETS_NOTE,
        "android-app is driven over adb: the action envelope's console and network deltas are " +
          "not captured on this engine.",
      ],
    });
  }

  /** A hardware or software key. A single printable character is TEXT and is
   *  typed, matching what the web engines do with `press("a")`. */
  async press(args: actions.PressArgs): Promise<ActionResult> {
    const action = { ...descriptorFor("press", args.target), value: args.key };
    if (args.target) {
      const at = await pointFor(this.elements, args.target);
      if ("error" in at) return nativeResult(action, false, { error: at.error });
      await this.io.tap(at.point.x, at.point.y).catch(() => undefined);
    }
    const keycode = androidKeyCode(args.key);
    try {
      if (keycode) await this.io.keyEvent(keycode);
      else if (args.key.length === 1) await this.io.typeText(args.key);
      else {
        return nativeResult(action, false, {
          error:
            `"${args.key}" is not an Android key. Use a name (\`back\`, \`home\`, \`enter\`, ` +
            "`tab`, `escape`, `backspace`, `delete`, `menu`, `search`, `appswitch`, the four " +
            "arrows), a raw `KEYCODE_*`, or a single character to type it.",
        });
      }
    } catch (err) {
      return nativeResult(action, false, { error: messageOf(err) });
    }
    return nativeResult(action, true);
  }

  /** A swipe in the opposite direction to the requested scroll. Scrolling a list
   *  DOWN means dragging the content UP, and getting that backwards is the
   *  classic native-automation bug, so the inversion is stated here once. */
  async scroll(args: actions.ScrollArgs): Promise<ActionResult> {
    const action = descriptorFor("scroll", args.target);
    const size = await this.io.screenSize();
    const centre = await this.scrollCentre(args, size);
    if ("error" in centre) return nativeResult(action, false, { error: centre.error });
    const delta = scrollDelta(args, size);
    if (!delta) {
      return nativeResult(action, false, {
        error:
          "`scroll` on android-app needs a direction: pass `to` (`top`/`bottom`/`left`/`right`) " +
          "or `by` ({x, y} in device pixels). Scrolling an element into view is not a native " +
          "primitive — `scroll({by})` until `snapshot` shows it.",
      });
    }
    const from = centre.point;
    const to = { x: from.x - delta.x, y: from.y - delta.y };
    try {
      await this.io.swipe(from, clampTo(to, size), SCROLL_DURATION_MS);
    } catch (err) {
      return nativeResult(action, false, { error: messageOf(err) });
    }
    return nativeResult(action, true);
  }

  private async scrollCentre(
    args: actions.ScrollArgs,
    size: { width: number; height: number },
  ): Promise<{ point: { x: number; y: number } } | { error: string }> {
    if (!args.target) return { point: { x: size.width / 2, y: size.height / 2 } };
    return pointFor(this.elements, args.target);
  }

  async goBack(): Promise<ActionResult> {
    // The one navigation verb Android really has. `go_forward` does not exist on
    // the platform at all, which is why it refuses below.
    try {
      await this.io.keyEvent("KEYCODE_BACK");
    } catch (err) {
      return nativeResult({ type: "goBack" }, false, { error: messageOf(err) });
    }
    return nativeResult({ type: "goBack" }, true);
  }

  async goForward(): Promise<ActionResult> {
    return nativeUnsupportedAction(
      "goForward",
      "has no Android analogue: the platform's navigation stack is back-only. Use `navigate` " +
        "with a deep link to reach a screen directly.",
    );
  }

  async hover(): Promise<ActionResult> {
    return nativeUnsupportedAction(
      "hover",
      "has no meaning on a touch screen — there is no pointer to rest anywhere. Use `click`, or " +
        "`gesture_swipe` for a drag.",
    );
  }

  async select(): Promise<ActionResult> {
    return nativeUnsupportedAction(
      "select",
      "is an HTML `<select>` operation. An Android picker is a normal view: `click` it open, " +
        "`snapshot`, then `click` the option.",
    );
  }

  async chooseOption(): Promise<ActionResult> {
    return nativeUnsupportedAction(
      "chooseOption",
      "is an HTML `<select>` operation. Tap the picker, `snapshot`, then tap the option.",
    );
  }

  async setViewport(): Promise<ActionResult> {
    return nativeUnsupportedAction(
      "setViewport",
      "would resize the device display. browxai does not reshape the operator's device; boot an " +
        "emulator with the screen geometry you want instead.",
    );
  }

  /** Polling `wait_for` belongs to the handler, which owns the deadline and the
   *  predicate. What this engine cannot offer is a locator-state wait, so the
   *  refusal names the loop to run instead. */
  async waitFor(): Promise<ActionResult> {
    return nativeUnsupportedAction(
      "waitFor",
      "has no locator-state equivalent on a view hierarchy. Poll `snapshot` or `verify_visible` " +
        "until the element appears — a UiAutomator dump already blocks until the window is idle.",
    );
  }

  /** The three gesture primitives. See the module header for why `pinch`
   *  refuses. */
  async gesture(req: GestureRequest): Promise<GestureResult> {
    switch (req.kind) {
      case "swipe":
        return this.dispatchSwipe(req);
      case "touch":
        return this.dispatchTouch(req);
      case "pinch":
        return this.refusePinch(req);
    }
  }

  private async dispatchSwipe(req: SwipeRequest): Promise<GestureResult> {
    const durationMs = req.durationMs ?? SCROLL_DURATION_MS;
    await this.io.swipe(req.from, req.to, durationMs);
    return {
      kind: "dispatched",
      report: {
        ok: true,
        from: req.from,
        to: req.to,
        // `input swipe` interpolates in the kernel driver, so there is no step
        // count to report. Echoing the caller's `steps` would claim a fidelity
        // this path does not have; 0 says "the platform chose".
        steps: 0,
        durationMs,
      },
    };
  }

  private async dispatchTouch(req: TouchRequest): Promise<GestureResult> {
    const phase = req.phase === "start" ? "DOWN" : req.phase === "move" ? "MOVE" : "UP";
    if (!req.coords) {
      return {
        kind: "refusal",
        error: `tool "touch_${req.phase}" needs coordinates on the "${this.engine}" engine`,
        engine: this.engine,
        hint:
          "`input motionevent` takes a point on every phase, including UP — the platform has no " +
          '"all fingers up" form. Pass `coords` with the point the finger lifts at.',
      };
    }
    await this.io.motionEvent(phase, req.coords.x, req.coords.y);
    return {
      kind: "dispatched",
      report: { ok: true, action: req.phase, coords: req.coords, identifier: req.identifier ?? 1 },
    };
  }

  private async refusePinch(req: PinchRequest): Promise<GestureResult> {
    return {
      kind: "refusal",
      error: `tool "gesture_pinch" is not supported on the "${this.engine}" engine`,
      engine: this.engine,
      hint:
        `${NATIVE_PINCH_REFUSAL}: a two-finger gesture has no primitive in \`adb shell input\`. ` +
        "Two concurrent `input swipe` calls produce two independent single-pointer streams, " +
        "which an app sees as two unrelated drags and not a pinch, so there is no fallback and " +
        "this is a refusal rather than a degraded result. Real multi-touch needs a device-side " +
        "UiAutomator2 instrumentation server, which browxai does not ship. `gesture_swipe` and " +
        `\`touch_*\` are real primitives on this engine (scale requested: ${req.scale}).`,
    };
  }
}

/** Greppable, and the thing a test asserts on instead of prose. */
export const NATIVE_PINCH_REFUSAL = "native-pinch-needs-multitouch-driver";

/** Said on every `fill`, because an agent that registered a secret has no other
 *  way to learn it was not substituted. */
export const NATIVE_FILL_SECRETS_NOTE =
  "Registered secrets do NOT materialise on the android-app engine: a `<NAME>` alias is typed " +
  "literally. Secret substitution lives in the Playwright action core, which a native session " +
  "never reaches. This is also why RFC 0008 §6's `adb shell input text <secret>` leak sink does " +
  "not exist here — the real value never arrives.";

/** How far one scroll moves, in device pixels, and in which direction. Positive
 *  `y` means "scroll down", which drags the content UP. */
function scrollDelta(
  args: actions.ScrollArgs,
  size: { width: number; height: number },
): { x: number; y: number } | null {
  if (args.by) return { x: args.by.x ?? 0, y: args.by.y ?? 0 };
  const span = { x: size.width * SCROLL_FRACTION, y: size.height * SCROLL_FRACTION };
  switch (args.to) {
    case "top":
      return { x: 0, y: -span.y };
    case "bottom":
      return { x: 0, y: span.y };
    case "left":
      return { x: -span.x, y: 0 };
    case "right":
      return { x: span.x, y: 0 };
    default:
      return null;
  }
}

/** Keep a swipe endpoint on the display. A swipe that ends off-screen is
 *  truncated by the driver at an arbitrary point, so the distance the app sees
 *  stops matching the distance requested. */
function clampTo(
  p: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(p.x, 1), size.width - 1),
    y: Math.min(Math.max(p.y, 1), size.height - 1),
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
