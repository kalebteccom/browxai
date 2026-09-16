// SafariScriptSubstrate — the ScriptSubstrate implementation over WebDriver
// Classic. safaridriver has no Playwright Page; `execute/sync` takes a function
// BODY, so the bare expression is wrapped in `return (…)` to evaluate it and
// return its value — the verbatim wrapping from the handler's deleted Safari
// branch, so the engine specifics live here, not as an engine check in the
// handler.
//
// Dependency direction (architecture doctrine §1): tool handler → ScriptSubstrate
// (the port in `script-substrate-types.ts`) → this implementation → safaridriver.
// This file never imports back from the `script-substrate.js` barrel.

import type { SafariSessionHandle } from "../engine/index.js";
import type { ScriptSubstrate } from "./script-substrate-types.js";

export class SafariScriptSubstrate implements ScriptSubstrate {
  readonly engine = "safari";
  constructor(private readonly handle: SafariSessionHandle) {}
  evaluate(expr: string): Promise<unknown> {
    return this.handle.webDriver.executeScript(this.handle.sessionId, `return (${expr});`);
  }
}
