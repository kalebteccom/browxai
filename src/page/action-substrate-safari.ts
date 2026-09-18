// SafariActionSubstrate — the ActionSubstrate implementation over WebDriver
// Classic (safaridriver, no Playwright Page). The curated subset
// (navigate / click / fill / press) is real; everything else refuses cleanly HERE,
// so the gating lives in the adapter and not as `if (engine === "safari")`
// branches scattered through the handlers.
//
// Dependency direction (architecture doctrine §1): tool handler → ActionSubstrate
// (the port in `action-substrate-types.ts`) → this implementation → safaridriver.
// This file never imports back from the `action-substrate.js` barrel.

import type { ActionResult } from "./actionresult.js";
import type { ActionSubstrate } from "./action-substrate-types.js";
import type * as actions from "./actions.js";
import type { RefRegistry } from "./refs.js";
import type { SafariSessionHandle } from "../engine/index.js";
import { directDispatchUnsupported } from "./actions-direct-dispatch.js";
import {
  touchDispatchUnsupported,
  type GestureRequest,
  type GestureResult,
} from "./gesture-types.js";
import {
  safariNavigate,
  safariClick,
  safariFill,
  safariPress,
  safariUnsupportedAction,
} from "./safari-actions.js";

export class SafariActionSubstrate implements ActionSubstrate {
  readonly engine = "safari";
  constructor(
    private readonly handle: SafariSessionHandle,
    private readonly refs: RefRegistry,
  ) {}
  async navigate(args: actions.NavigateArgs): Promise<ActionResult> {
    return safariNavigate(this.handle, args.url);
  }
  async click(args: actions.ClickArgs): Promise<ActionResult> {
    if (args.dispatch === "direct") {
      return directDispatchUnsupported(args.target, this.engine);
    }
    return safariClick(this.handle, this.refs, args.target);
  }
  async fill(args: actions.FillArgs): Promise<ActionResult> {
    return safariFill(this.handle, this.refs, args.target, args.value);
  }
  async press(args: actions.PressArgs): Promise<ActionResult> {
    return args.target
      ? safariPress(this.handle, this.refs, args.target, args.key)
      : safariUnsupportedAction("press");
  }
  async hover(): Promise<ActionResult> {
    return safariUnsupportedAction("hover");
  }
  async select(): Promise<ActionResult> {
    return safariUnsupportedAction("select");
  }
  async scroll(): Promise<ActionResult> {
    return safariUnsupportedAction("scroll");
  }
  async goBack(): Promise<ActionResult> {
    return safariUnsupportedAction("goBack");
  }
  async goForward(): Promise<ActionResult> {
    return safariUnsupportedAction("goForward");
  }
  async chooseOption(): Promise<ActionResult> {
    return safariUnsupportedAction("chooseOption");
  }
  async setViewport(): Promise<ActionResult> {
    return safariUnsupportedAction("setViewport");
  }
  async waitFor(): Promise<ActionResult> {
    return safariUnsupportedAction("waitFor");
  }

  /** safaridriver's WebDriver Classic lane has `performActions`, but browxai's
   *  Safari client drives the curated navigate / click / fill / press subset and
   *  no pointer-source sequence. So the touch pipeline refuses here, with the
   *  same envelope the engine gate rendered while these tools were `deep: true`
   *  — Safari declares `deep:false`, so it was refused then too. */
  async gesture(req: GestureRequest): Promise<GestureResult> {
    return touchDispatchUnsupported(req, this.engine);
  }
}
