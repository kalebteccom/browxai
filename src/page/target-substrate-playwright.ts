// PlaywrightTargetSubstrate — the TargetSubstrate implementation for the
// Playwright engines (chromium / firefox / webkit / android). Both members are
// the verbatim body of the `e.session.page().url()` / `.title()` calls they
// replace: `page.url()` is a synchronous in-process read (no round trip, so the
// port costs the caller one microtask and no IO), and `page.title()` was already
// async.
//
// `async` is load-bearing on BOTH members, not decoration. The injected `page`
// thunk is `() => requirePage(e.session)`, and on an attached (BYOB) session that
// resolves to a bound page that THROWS once the user closes the tab. In a
// non-async method typed `Promise<T>` that throw escapes synchronously, before a
// promise exists — so every caller's `.catch(() => null)` is dead code and the
// handler dies instead of degrading. `async` turns the same throw into a
// rejection the guard can see. Every method on every substrate adapter is `async`
// for this reason; `substrate-adapters-async.test.ts` is the gate.
//
// Dependency direction (architecture doctrine §1): tool handler → TargetSubstrate
// (the port in `target-substrate-types.ts`) → this implementation → Playwright
// Page. This file never imports back from the `target-substrate.js` barrel.

import type { Page } from "playwright-core";
import type { TargetSubstrate } from "./target-substrate-types.js";

export class PlaywrightTargetSubstrate implements TargetSubstrate {
  readonly engine: string;
  constructor(
    private readonly page: () => Page,
    engine = "chromium",
  ) {
    this.engine = engine;
  }

  async url(): Promise<string> {
    return this.page().url();
  }

  async title(): Promise<string> {
    return this.page().title();
  }
}
