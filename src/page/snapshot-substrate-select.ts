// Substrate selection — maps a live session to its SnapshotSubstrate. This is
// the seam where the engine's snapshot strategy is chosen: chromium (CDP) gets
// the verbatim CDP substrate; an engine with no CDP escape hatch (firefox /
// webkit) gets the page-side Playwright walker. Per RFC 0002 D4 the choice is
// the engine's, declared by whether it exposes the raw-CDP handle — not an
// engine-name check scattered through the tools.
//
// The session layer wires one substrate per entry at creation (server.ts) so the
// per-call path is a captured-handle delegate with no per-call allocation (the
// snapshot/find path is hot — architecture doctrine §3). Tools select via this
// substrate, never via `requireCdp` + an engine branch.

import type { Page } from "playwright-core";
import type { SafariSessionHandle } from "../engine/index.js";
import {
  CdpSnapshotSubstrate,
  PlaywrightSnapshotSubstrate,
  type SnapshotSubstrate,
} from "./snapshot-substrate.js";
import { SafariClassicSnapshotSubstrate } from "./snapshot-substrate-safari.js";

/** The minimal session shape this selector needs — the optional CDP accessor
 *  (present only on chromium) + the engine tag + the page handle + the optional
 *  Safari-native handle (present only on the `safari` engine, which has no
 *  Playwright Page). The full BrowserSession satisfies it; the narrow shape keeps
 *  the engine/session interfaces out of this page-layer module. */
export interface SubstrateCapableSession {
  readonly engine: string;
  page(): Page;
  cdp?(): import("playwright-core").CDPSession;
  safari?(): SafariSessionHandle;
}

/** Build the SnapshotSubstrate for a session. Selection is by capability, never a
 *  scattered engine-name check:
 *   - Safari (no Playwright Page, no CDP) → the WebDriver-Classic DOM-walk
 *     substrate, fed by the Safari handle's `execute/sync` (RFC 0002 P4).
 *   - Chromium / Android (CDP present) → the byte-identical CDP substrate.
 *   - Firefox / WebKit (Playwright Page, no CDP) → the page-side walker.
 *  A future CDP-bearing engine routes to the CDP substrate automatically; a
 *  non-CDP Playwright one to the walker — no edit here. Safari is the one engine
 *  whose `page()` throws, so it MUST be handled before the Playwright branch. */
export function snapshotSubstrateFor(session: SubstrateCapableSession): SnapshotSubstrate {
  if (session.engine === "safari" && session.safari) {
    const handle = session.safari();
    return new SafariClassicSnapshotSubstrate({
      exec: (scriptBody, args) =>
        handle.webDriver.executeScript(handle.sessionId, scriptBody, args),
      currentUrl: () => handle.webDriver.currentUrl(handle.sessionId),
    });
  }
  if (session.cdp) return new CdpSnapshotSubstrate(session.cdp());
  return new PlaywrightSnapshotSubstrate(session.page(), session.engine);
}
