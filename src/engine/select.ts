// Engine selection. The launch path resolves an `EngineKind` to a Playwright
// browser-type and rejects the not-yet-implemented engines with a structured,
// RFC-naming error — the doctrine's no-silent-no-op rule: an unsupported engine
// must fail loudly, naming where the work is tracked, not quietly fall back to
// Chromium.

import { chromium, firefox, webkit, type BrowserType } from "playwright-core";
import type { EngineKind } from "./types.js";

// `android` resolves to Playwright's `chromium` BrowserType — Chrome-on-Android
// speaks full CDP, so the adapter attaches with `chromium.connectOverCDP(wsUrl)`
// over an adb-forwarded socket, reusing the exact Chromium transport (RFC D8).
const BROWSER_TYPES: Record<EngineKind, BrowserType> = {
  chromium,
  firefox,
  webkit,
  android: chromium,
};

/** Engines wired today. Chromium (P0) + Firefox (P1, Playwright's bundled
 *  Juggler build) + WebKit (P2c, Playwright's bundled WebKit build — the WebKit-
 *  ENGINE correctness lane per RFC D7, NOT Safari) + Android (P3, real Chrome-on-
 *  Android attached over adb + CDP per RFC D3/D8 — full CDP, `deep: true`). All
 *  four `EngineKind` members are implemented; the no-silent-no-op selection error
 *  remains for any future engine declared before its adapter lands. */
export const IMPLEMENTED_ENGINES: readonly EngineKind[] = [
  "chromium",
  "firefox",
  "webkit",
  "android",
];

export class EngineNotYetSupportedError extends Error {
  readonly engine: EngineKind;
  constructor(engine: EngineKind) {
    super(
      `engine-not-yet-supported: "${engine}" is declared but not yet implemented — ` +
        "chromium, firefox, webkit, and android are wired today " +
        "(see docs/rfcs/0002-multi-engine-bidi.md). " +
        'Use browserType:"chromium" (the default), "firefox", "webkit", or "android".',
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
  // chromium + firefox + webkit + android all reach here today (android maps to
  // the chromium BrowserType — it attaches to real Chrome-on-Android over CDP).
  return BROWSER_TYPES[engine];
}
