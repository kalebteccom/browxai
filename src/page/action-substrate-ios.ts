// `IosActionSubstrate` — the ActionSubstrate implementation for the ios-app
// engine. The verbs XCUITest genuinely has (navigate-as-deep-link, click-as-tap,
// fill, press, scroll, swipe, pinch) are real; the rest refuse HERE, naming what
// the platform lacks, so the gating lives in the adapter and never as an
// `if (engine === "ios-app")` branch in a handler.
//
// Dependency direction (architecture doctrine §1): tool handler → ActionSubstrate
// (the port in `action-substrate-types.ts`) → this implementation → the native
// driver. This file never imports back from the `action-substrate.js` barrel.

import type { NativeSessionHandle } from "../engine/native-types.js";
import type { ActionResult } from "./actionresult-types.js";
import type { ActionSubstrate } from "./action-substrate-types.js";
import type * as actions from "./actions-types.js";
import { directDispatchUnsupported } from "./actions-direct-dispatch.js";
import type { ElementSubstrate } from "./element-substrate-types.js";
import type { GestureRequest, GestureResult } from "./gesture-types.js";
import {
  iosClick,
  iosFill,
  iosNavigate,
  iosPress,
  iosUnsupported,
  type IosActionDeps,
} from "./ios-actions.js";
import { iosGesture, iosScroll } from "./ios-gestures.js";

export class IosActionSubstrate implements ActionSubstrate {
  readonly engine = "ios-app";
  private readonly deps: IosActionDeps;

  constructor(
    private readonly handle: NativeSessionHandle,
    elements: ElementSubstrate,
  ) {
    this.deps = { handle, elements };
  }

  async navigate(args: actions.NavigateArgs): Promise<ActionResult> {
    return iosNavigate(this.deps, args.url);
  }

  async click(args: actions.ClickArgs): Promise<ActionResult> {
    if (args.dispatch === "direct") {
      // `direct` means "skip the locator engine's pre-dispatch checks and
      // dispatch at a measured point". Every tap on this engine is already
      // dispatched at a point measured from a fresh resolution, so there is no
      // second, cheaper path to select — and answering as though there were
      // would be answering a question the engine cannot distinguish.
      return directDispatchUnsupported(args.target, this.engine);
    }
    return iosClick(this.deps, args.target);
  }

  async fill(args: actions.FillArgs): Promise<ActionResult> {
    return iosFill(this.deps, args.target, args.value);
  }

  async press(args: actions.PressArgs): Promise<ActionResult> {
    return iosPress(this.deps, args.key, args.target);
  }

  async hover(): Promise<ActionResult> {
    return iosUnsupported(
      "hover",
      "a touch screen has no hover state and XCUITest has no pointer to move. The nearest " +
        "primitive is a long press, which is a different interaction and is not silently " +
        "substituted here.",
    );
  }

  async select(): Promise<ActionResult> {
    return iosUnsupported(
      "select",
      "there is no `<select>` element. An iOS picker is a `PickerWheel` in the hierarchy — " +
        "`snapshot` it and act on the wheel's own entries.",
    );
  }

  async scroll(args: actions.ScrollArgs): Promise<ActionResult> {
    return iosScroll(this.handle, args);
  }

  async goBack(): Promise<ActionResult> {
    return iosUnsupported(
      "navigate",
      "iOS has no back key and no history stack a driver can walk. Tap the navigation bar's back " +
        "button, which `snapshot` reports, or use `gesture_swipe` for the edge-swipe gesture.",
    );
  }

  async goForward(): Promise<ActionResult> {
    return iosUnsupported("navigate", "a native app has no forward history to walk.");
  }

  async chooseOption(): Promise<ActionResult> {
    return iosUnsupported(
      "select",
      "there is no option list to choose from. Act on the picker's entries in the hierarchy.",
    );
  }

  async setViewport(): Promise<ActionResult> {
    return iosUnsupported(
      "set_viewport",
      "a simulator's screen size is fixed by the device type. Boot a different simulator " +
        "(BROWX_IOS_DEVICE names one) to test another screen size.",
    );
  }

  async waitFor(): Promise<ActionResult> {
    return iosUnsupported(
      "wait_for",
      "polling the XCUITest hierarchy for a predicate is not implemented on this engine yet. " +
        "Each dump is a full round trip, so a poll needs a cost budget that has not been " +
        "measured; `snapshot` and `find` re-read the screen on demand in the meantime.",
    );
  }

  async gesture(req: GestureRequest): Promise<GestureResult> {
    return iosGesture(this.handle, req);
  }
}
