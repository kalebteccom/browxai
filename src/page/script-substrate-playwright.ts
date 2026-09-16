// PlaywrightScriptSubstrate — the ScriptSubstrate implementation for the
// Playwright engines (chromium / firefox / webkit / android). Delegates to
// `page.evaluate(expr)` verbatim. `page.evaluate` carries no Playwright timeout (a
// never-resolving expr would wedge forever), so the handler races the returned
// promise against the anti-wedge deadline exactly as it did pre-seam. No
// behaviour change.
//
// Dependency direction (architecture doctrine §1): tool handler → ScriptSubstrate
// (the port in `script-substrate-types.ts`) → this implementation → Playwright
// Page. This file never imports back from the `script-substrate.js` barrel.

import type { Page } from "playwright-core";
import type { ScriptSubstrate } from "./script-substrate-types.js";

export class PlaywrightScriptSubstrate implements ScriptSubstrate {
  readonly engine: string;
  constructor(
    private readonly page: () => Page,
    engine = "chromium",
  ) {
    this.engine = engine;
  }
  async evaluate(expr: string): Promise<unknown> {
    return this.page().evaluate(expr);
  }
}
