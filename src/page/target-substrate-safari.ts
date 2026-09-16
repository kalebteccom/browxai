// SafariTargetSubstrate — the TargetSubstrate implementation over WebDriver
// Classic. safaridriver has no Playwright Page: the URL is `GET /session/:id/url`
// and the title comes back through the same `execute/sync` endpoint the Safari
// snapshot substrate already drives. Both are real network round trips, which is
// why the port's members are async.
//
// This is the second implementation that justifies the port. It is also the body
// the handlers used to carry inline as `if (session.safari) { … }` branches
// (session-lifecycle-tools.ts, read-observe-dom-tools.ts) — moved here so the
// handler stops naming the engine.
//
// Dependency direction (architecture doctrine §1): tool handler → TargetSubstrate
// (the port in `target-substrate-types.ts`) → this implementation → safaridriver.
// This file never imports back from the `target-substrate.js` barrel.

import type { SafariSessionHandle } from "../engine/index.js";
import type { TargetSubstrate } from "./target-substrate-types.js";

export class SafariTargetSubstrate implements TargetSubstrate {
  readonly engine = "safari";
  constructor(private readonly handle: SafariSessionHandle) {}

  url(): Promise<string> {
    return this.handle.webDriver.currentUrl(this.handle.sessionId);
  }

  async title(): Promise<string> {
    const t = await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      "return document.title",
    );
    return typeof t === "string" ? t : "";
  }
}
