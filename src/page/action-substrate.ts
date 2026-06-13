// The ActionSubstrate interface — the engine-agnostic seam beneath the action
// tools (navigate / click / fill / press / hover / select / scroll / …). It is
// the action side of RFC 0003: a tool handler asks a substrate to perform an
// action and gets back the universal `ActionResult`; an engine-specific
// implementation does the work. The handler never names Playwright, CDP, or an
// engine — it calls `actionsFor(e).click(args)`, the same shape as
// `snapshotSubstrateFor(e.session).compose(...)`.
//
// Dependency direction (architecture doctrine §1): tool handler → ActionSubstrate
// (this interface) → implementation → Playwright | safaridriver. Two impls today:
//   - PlaywrightActionSubstrate (chromium / firefox / webkit / android): wraps the
//     existing `actions.*` over a Playwright ActionContext — byte-identical to the
//     pre-seam path, so the four engines' keystones stay green unchanged.
//   - SafariActionSubstrate (safari): wraps `safari-actions.*` over the WebDriver
//     Classic client (no Playwright Page). The curated subset (navigate/click/
//     fill/press) is real; the rest refuse cleanly IN THE ADAPTER — so the gating
//     lives here, not as `if (engine === "safari")` branches scattered through the
//     handlers.

import type { ActionContext, ActionResult } from "./actionresult.js";
import type { RefRegistry } from "./refs.js";
import type { SafariSessionHandle } from "../engine/index.js";
import * as actions from "./actions.js";
import {
  safariNavigate,
  safariClick,
  safariFill,
  safariPress,
  safariUnsupportedAction,
} from "./safari-actions.js";

/** The action capability port. One instance wraps one session's engine handle;
 *  the methods carry no engine type, so the handlers above this seam are
 *  engine-blind. Mirrors the SnapshotSubstrate / NetworkSubstrate shape. */
export interface ActionSubstrate {
  readonly engine: string;
  navigate(args: actions.NavigateArgs): Promise<ActionResult>;
  click(args: actions.ClickArgs): Promise<ActionResult>;
  fill(args: actions.FillArgs): Promise<ActionResult>;
  press(args: actions.PressArgs): Promise<ActionResult>;
  hover(args: actions.HoverArgs): Promise<ActionResult>;
  select(args: actions.SelectArgs): Promise<ActionResult>;
  scroll(args: actions.ScrollArgs): Promise<ActionResult>;
  goBack(args: actions.GoBackArgs): Promise<ActionResult>;
  goForward(args: actions.GoForwardArgs): Promise<ActionResult>;
  chooseOption(args: actions.ChooseOptionArgs): Promise<ActionResult>;
  setViewport(args: actions.SetViewportArgs): Promise<ActionResult>;
  waitFor(args: actions.WaitForArgs): Promise<ActionResult>;
}

/** Playwright engines — delegates each action to the existing `actions.*` over a
 *  freshly-built ActionContext (the `ctx` thunk captures the session entry, the
 *  same per-call construction the handlers did before this seam). No behaviour
 *  change. */
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
    return actions.click(this.ctx(), args);
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

/** Safari — the WebDriver-Classic action path. The curated subset is real;
 *  everything else refuses cleanly here (the gating is in the adapter, not the
 *  handler). RFC 0002 D7 / RFC 0003. */
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
