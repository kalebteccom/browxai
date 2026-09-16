// PlaywrightTargetSubstrate — the TargetSubstrate implementation for the
// Playwright engines (chromium / firefox / webkit / android). Both members are
// the verbatim body of the `e.session.page().url()` / `.title()` calls they
// replace: `page.url()` is a synchronous in-process read wrapped in a resolved
// promise (no round trip, so the port costs the caller one microtask and no IO),
// and `page.title()` was already async.
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

  url(): Promise<string> {
    return Promise.resolve(this.page().url());
  }

  title(): Promise<string> {
    return this.page().title();
  }
}
