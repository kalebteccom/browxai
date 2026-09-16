// Substrate selection — maps a live session to its SnapshotSubstrate. This is
// the seam where the engine's snapshot strategy is chosen: an engine that backs
// no Playwright Page gets the WebDriver-Classic walker; chromium (CDP) gets the
// verbatim CDP substrate; an engine with a Page but no CDP escape hatch (firefox
// / webkit) gets the page-side Playwright walker.
//
// Every branch keys on a DECLARED capability, never on an engine name. The
// `session.engine === "safari"` literal this file used to open with was a second
// spelling of `caps.subInterfaces.has("page")` — the fact RFC 0004 D5 already
// declares — and the second spelling is the one that needs a new branch per
// engine. Reading the declaration means the two native engines RFC 0008 adds
// route correctly with no edit here. (RFC 0009 P1.)
//
// The session layer wires one substrate per entry at creation (server.ts) so the
// per-call path is a captured-handle delegate with no per-call allocation (the
// snapshot/find path is hot — architecture doctrine §3). Tools select via this
// substrate, never via `requireCdp` + an engine branch.

import type { EngineKind, SafariSessionHandle } from "../engine/index.js";
import { engineDeclares } from "../engine/sub-interface.js";
import { requirePage } from "../engine/session-page.js";
import {
  CdpSnapshotSubstrate,
  PlaywrightSnapshotSubstrate,
  type SnapshotSubstrate,
} from "./snapshot-substrate.js";
import { SafariClassicSnapshotSubstrate } from "./snapshot-substrate-safari.js";

/** The minimal session shape this selector needs — the engine tag (the key into
 *  the capability declaration) plus the optional CDP accessor, the optional Page
 *  accessor and the optional Safari-native handle. The full BrowserSession
 *  satisfies it; the narrow shape keeps the session interface out of this
 *  page-layer module. */
export interface SubstrateCapableSession {
  readonly engine: EngineKind;
  page?(): import("playwright-core").Page;
  cdp?(): import("playwright-core").CDPSession;
  safari?(): SafariSessionHandle;
}

/** Build the SnapshotSubstrate for a session. Selection is by declared
 *  capability, never a scattered engine-name check:
 *   - No `page` sub-interface, Safari-native handle present → the
 *     WebDriver-Classic DOM-walk substrate, fed by the handle's `execute/sync`.
 *   - Chromium / Android (CDP present) → the byte-identical CDP substrate.
 *   - Firefox / WebKit (Playwright Page, no CDP) → the page-side walker.
 *  A future CDP-bearing engine routes to the CDP substrate automatically; a
 *  non-CDP Playwright one to the walker — no edit here. The no-Page branch runs
 *  FIRST because on such an engine `page()` is absent or throws. */
export function snapshotSubstrateFor(session: SubstrateCapableSession): SnapshotSubstrate {
  if (!engineDeclares(session.engine, "page") && session.safari) {
    const handle = session.safari();
    return new SafariClassicSnapshotSubstrate({
      exec: (scriptBody, args) =>
        handle.webDriver.executeScript(handle.sessionId, scriptBody, args),
      currentUrl: () => handle.webDriver.currentUrl(handle.sessionId),
    });
  }
  if (session.cdp) return new CdpSnapshotSubstrate(session.cdp());
  return new PlaywrightSnapshotSubstrate(requirePage(session), session.engine);
}
