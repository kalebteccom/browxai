// Engine selection. The launch path resolves an `EngineKind` to a Playwright
// browser-type and rejects the not-yet-implemented engines with a structured,
// RFC-naming error — the doctrine's no-silent-no-op rule: an unsupported engine
// must fail loudly, naming where the work is tracked, not quietly fall back to
// Chromium.

import { chromium, firefox, webkit, type BrowserType } from "playwright-core";
import type { EngineKind } from "./types.js";

const BROWSER_TYPES: Record<EngineKind, BrowserType> = { chromium, firefox, webkit };

/** Engines wired today. Chromium (P0) + Firefox (P1, Playwright's bundled
 *  Juggler build). WebKit is declared in `EngineKind` and rejected by
 *  `resolveBrowserType` until its adapter lands (RFC 0002 P2). */
export const IMPLEMENTED_ENGINES: readonly EngineKind[] = ["chromium", "firefox"];

export class EngineNotYetSupportedError extends Error {
  readonly engine: EngineKind;
  constructor(engine: EngineKind) {
    super(
      `engine-not-yet-supported: "${engine}" is declared but not yet implemented — ` +
        "chromium and firefox are wired today. WebKit lands as an adapter in a " +
        "later phase of the multi-engine work (see docs/rfcs/0002-multi-engine-bidi.md). " +
        'Use browserType:"chromium" (the default) or "firefox".',
    );
    this.name = "EngineNotYetSupportedError";
    this.engine = engine;
  }
}

/** Map an `EngineKind` to the Playwright `BrowserType` that drives it. Throws
 *  `EngineNotYetSupportedError` for engines without an adapter yet. The mapping
 *  is `playwright[browserType]` — the same surface every Playwright client
 *  selects on; only chromium is reachable in P0. */
export function resolveBrowserType(engine: EngineKind): BrowserType {
  if (!IMPLEMENTED_ENGINES.includes(engine)) {
    throw new EngineNotYetSupportedError(engine);
  }
  // chromium + firefox reach here today; the map is shaped for webkit too.
  return BROWSER_TYPES[engine];
}
