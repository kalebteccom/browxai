// Network substrate selection — maps a live session to its NetworkSubstrate.
// This is the seam where the engine's network strategy is chosen: chromium (CDP)
// gets the verbatim CDP substrate (NetworkBuffer / WsBuffer / NetworkTap /
// fetchResponseBody); an engine with no CDP escape hatch (firefox / webkit) gets
// the Playwright context-event substrate. Per RFC 0002 D5 the choice is the
// engine's, declared by whether it exposes the raw-CDP handle — not an engine-name
// check scattered through the tools. Mirrors `snapshotSubstrateFor` (P2a).
//
// The session layer wires one substrate per entry at creation (server.ts) so the
// per-call path is a captured-handle delegate: the session buffers are attached
// once, and the per-action tap the action window mints is the same allocation the
// CDP path already made. No new per-action cost on chromium (architecture doctrine
// §3 — the envelope is the hottest path; measured, see RFC D5).

import type { CDPSession, Page } from "playwright-core";
import {
  CdpNetworkSubstrate,
  PlaywrightNetworkSubstrate,
  type NetworkSubstrate,
} from "./network-substrate.js";

/** The minimal session shape this selector needs — the optional CDP accessor
 *  (present only on chromium) + the engine tag + the page handle. The full
 *  BrowserSession satisfies it; the narrow shape keeps the engine/session
 *  interfaces out of this page-layer module. */
export interface NetworkSubstrateCapableSession {
  readonly engine: string;
  page(): Page;
  cdp?(): CDPSession;
}

/** Build the NetworkSubstrate for a session. Chromium (CDP present) → the
 *  byte-identical CDP substrate; any engine without CDP → the Playwright context-
 *  event substrate. The presence of `cdp` is the capability signal — the same one
 *  `requireCdp` and `snapshotSubstrateFor` key on — so a future CDP-bearing engine
 *  routes to the CDP substrate automatically and a non-CDP one to the event path,
 *  with no edit here. */
export function networkSubstrateFor(
  session: NetworkSubstrateCapableSession,
): NetworkSubstrate {
  if (session.cdp) return new CdpNetworkSubstrate(session.cdp());
  const page = session.page();
  return new PlaywrightNetworkSubstrate(page.context(), page, session.engine);
}
