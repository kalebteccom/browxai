// PlaywrightActionSubstrate — the ActionSubstrate implementation for the
// Playwright engines (chromium / firefox / webkit / android). It delegates each
// action to the existing `actions.*` over a freshly-built ActionContext (the
// `ctx` thunk captures the session entry, the same per-call construction the
// handlers did before this seam). Byte-identical to the pre-split path.
//
// Dependency direction (architecture doctrine §1): tool handler → ActionSubstrate
// (the port in `action-substrate-types.ts`) → this implementation → Playwright.
// This file never imports back from the `action-substrate.js` barrel that
// re-exports it.

import type { ActionContext, ActionResult } from "./actionresult.js";
import type { ActionSubstrate } from "./action-substrate-types.js";
import * as actions from "./actions.js";
import { directDispatchUnsupported } from "./actions-direct-dispatch.js";

export class PlaywrightActionSubstrate implements ActionSubstrate {
  readonly engine: string;
  constructor(
    private readonly ctx: () => ActionContext,
    engine = "chromium",
  ) {
    this.engine = engine;
  }
  navigate(args: actions.NavigateArgs): Promise<ActionResult> {
    return actions.navigate(this.ctx(), args);
  }
  click(args: actions.ClickArgs): Promise<ActionResult> {
    const ctx = this.ctx();
    if (args.dispatch === "direct" && !ctx.cdp) {
      return Promise.resolve(directDispatchUnsupported(args.target, this.engine));
    }
    return actions.click(ctx, args);
  }
  fill(args: actions.FillArgs): Promise<ActionResult> {
    return actions.fill(this.ctx(), args);
  }
  press(args: actions.PressArgs): Promise<ActionResult> {
    return actions.press(this.ctx(), args);
  }
  hover(args: actions.HoverArgs): Promise<ActionResult> {
    return actions.hover(this.ctx(), args);
  }
  select(args: actions.SelectArgs): Promise<ActionResult> {
    return actions.select(this.ctx(), args);
  }
  scroll(args: actions.ScrollArgs): Promise<ActionResult> {
    return actions.scroll(this.ctx(), args);
  }
  goBack(args: actions.GoBackArgs): Promise<ActionResult> {
    return actions.goBack(this.ctx(), args);
  }
  goForward(args: actions.GoForwardArgs): Promise<ActionResult> {
    return actions.goForward(this.ctx(), args);
  }
  chooseOption(args: actions.ChooseOptionArgs): Promise<ActionResult> {
    return actions.chooseOption(this.ctx(), args);
  }
  setViewport(args: actions.SetViewportArgs): Promise<ActionResult> {
    return actions.setViewport(this.ctx(), args);
  }
  waitFor(args: actions.WaitForArgs): Promise<ActionResult> {
    return actions.waitFor(this.ctx(), args);
  }
}
