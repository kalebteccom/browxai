// The ActionSubstrate port — the engine-agnostic seam beneath the action tools
// (navigate / click / fill / press / hover / select / scroll / …). A tool handler
// asks a substrate to perform an action and gets back the universal
// `ActionResult`; an engine-specific implementation does the work. The handler
// never names Playwright, CDP, or an engine — it calls `actionsFor(e).click(args)`,
// the same shape as `snapshotSubstrateFor(e.session).compose(...)`.
//
// Dependency direction (architecture doctrine §1): tool handler → ActionSubstrate
// (this port) → implementation → Playwright | safaridriver. Split out of
// `action-substrate.ts` so the port module names no vendor type and the two
// implementations live in their own siblings (`action-substrate-playwright.ts`,
// `action-substrate-safari.ts`), the storage-substrate shape. Re-exported through
// `./action-substrate.js` so callers import unchanged. (RFC 0009 P1.)

import type { ActionResult } from "./actionresult.js";
import type * as actions from "./actions.js";

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
