// The ScriptSubstrate interface — the engine-agnostic seam beneath page-side JS
// evaluation (`eval_js` today; `exposeBinding` / `addInitScript` later). It keeps
// engine specifics out of the handler: the `eval_js` handler asks a substrate to
// evaluate an expression and gets back the page-controlled value; an engine-specific
// implementation does the work. The handler never names Playwright, safaridriver,
// or an engine — it calls `scriptFor(e).evaluate(expr)`, the same shape as
// `actionsFor(e).click(args)` / `captureFor(e).screenshot(args)`.
//
// Dependency direction (architecture doctrine §1): tool handler → ScriptSubstrate
// (this interface) → implementation → Playwright | safaridriver. Two impls today:
//   - PlaywrightScriptSubstrate (chromium / firefox / webkit / android): wraps
//     `page.evaluate(expr)` verbatim — byte-identical to the pre-seam handler, so
//     the four engines' keystones stay green unchanged.
//   - SafariScriptSubstrate (safari): wraps `webDriver.executeScript` over the
//     WebDriver Classic `execute/sync` endpoint, wrapping the expression in
//     `return (…)` (an expression, not a statement body) exactly as the handler's
//     deleted `if (sh)` branch did — so the engine specifics live here, not as an
//     engine check in the handler.

import type { Page } from "playwright-core";
import type { SafariSessionHandle } from "../engine/index.js";

/** The script capability port. One instance wraps one session's engine handle;
 *  the method carries no engine type, so the handler above this seam is
 *  engine-blind. Mirrors the ActionSubstrate / CaptureSubstrate shape. The
 *  returned value is page-controlled (untrusted); the handler treats it the same
 *  as snapshot text. The deadline race + error envelope stay in the handler — the
 *  substrate only performs the raw evaluation. */
export interface ScriptSubstrate {
  readonly engine: string;
  evaluate(expr: string): Promise<unknown>;
}

/** Playwright engines — delegates to `page.evaluate(expr)` verbatim. `page.evaluate`
 *  carries no Playwright timeout (a never-resolving expr would wedge forever), so the
 *  handler races the returned promise against the anti-wedge deadline exactly as it
 *  did pre-seam. No behaviour change. */
export class PlaywrightScriptSubstrate implements ScriptSubstrate {
  readonly engine: string;
  constructor(
    private readonly page: () => Page,
    engine = "chromium",
  ) {
    this.engine = engine;
  }
  evaluate(expr: string): Promise<unknown> {
    return this.page().evaluate(expr);
  }
}

/** Safari — the WebDriver-Classic eval path. safaridriver has no Playwright Page;
 *  `execute/sync` takes a function BODY, so the bare expression is wrapped in
 *  `return (…)` to evaluate it and return its value — the verbatim wrapping from the
 *  handler's deleted Safari branch. */
export class SafariScriptSubstrate implements ScriptSubstrate {
  readonly engine = "safari";
  constructor(private readonly handle: SafariSessionHandle) {}
  evaluate(expr: string): Promise<unknown> {
    return this.handle.webDriver.executeScript(this.handle.sessionId, `return (${expr});`);
  }
}
