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
  navigate(args: actions.NavigateArgs): Promise<ActionResult> {
    return safariNavigate(this.handle, args.url);
  }
  click(args: actions.ClickArgs): Promise<ActionResult> {
    if (args.dispatch === "direct") {
      return Promise.resolve(directDispatchUnsupported(args.target, this.engine));
    }
    return safariClick(this.handle, this.refs, args.target);
  }
  fill(args: actions.FillArgs): Promise<ActionResult> {
    return safariFill(this.handle, this.refs, args.target, args.value);
  }
  press(args: actions.PressArgs): Promise<ActionResult> {
    return args.target
      ? safariPress(this.handle, this.refs, args.target, args.key)
      : Promise.resolve(safariUnsupportedAction("press"));
  }
  hover(): Promise<ActionResult> {
    return Promise.resolve(safariUnsupportedAction("hover"));
  }
  select(): Promise<ActionResult> {
    return Promise.resolve(safariUnsupportedAction("select"));
  }
  scroll(): Promise<ActionResult> {
    return Promise.resolve(safariUnsupportedAction("scroll"));
  }
  goBack(): Promise<ActionResult> {
    return Promise.resolve(safariUnsupportedAction("goBack"));
  }
  goForward(): Promise<ActionResult> {
    return Promise.resolve(safariUnsupportedAction("goForward"));
  }
  chooseOption(): Promise<ActionResult> {
    return Promise.resolve(safariUnsupportedAction("chooseOption"));
  }
  setViewport(): Promise<ActionResult> {
    return Promise.resolve(safariUnsupportedAction("setViewport"));
  }
  waitFor(): Promise<ActionResult> {
    return Promise.resolve(safariUnsupportedAction("waitFor"));
  }
}
