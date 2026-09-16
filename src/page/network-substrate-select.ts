// Network substrate selection — maps a live session to its NetworkSubstrate.
// This is the seam where the engine's network strategy is chosen: an engine that
// backs no Playwright Page has nothing to feed the event path and gets the empty
// no-op; chromium (CDP) gets the verbatim CDP substrate (NetworkBuffer /
// WsBuffer / NetworkTap / fetchResponseBody); an engine with a Page but no CDP
// escape hatch (firefox / webkit) gets the Playwright context-event substrate.
//
// Every branch keys on a DECLARED capability, never on an engine name. The
// `session.engine === "safari"` literal this file used to open with was a second
// spelling of `caps.subInterfaces.has("page")` (RFC 0004 D5). Mirrors
// `snapshotSubstrateFor`. (RFC 0009 P1.)
//
// The session layer wires one substrate per entry at creation (server.ts) so the
// per-call path is a captured-handle delegate: the session buffers are attached
// once, and the per-action tap the action window mints is the same allocation the
// CDP path already made. No new per-action cost on chromium (the envelope is the
// hottest path, so the per-call delegate reuses the attached buffers rather than
// reallocating; measured).

import type { CDPSession, Page } from "playwright-core";
import type { EngineKind } from "../engine/index.js";
import { engineDeclares } from "../engine/sub-interface.js";
import { requirePage } from "../engine/session-page.js";
import {
  CdpNetworkSubstrate,
  PlaywrightNetworkSubstrate,
  SafariNoopNetworkSubstrate,
  type NetworkSubstrate,
} from "./network-substrate.js";

/** The minimal session shape this selector needs — the engine tag (the key into
 *  the capability declaration) plus the optional CDP and Page accessors. The full
 *  BrowserSession satisfies it; the narrow shape keeps the session interface out
 *  of this page-layer module. */
export interface NetworkSubstrateCapableSession {
  readonly engine: EngineKind;
  page?(): Page;
  cdp?(): CDPSession;
}

/** Build the NetworkSubstrate for a session. An engine declaring no `page`
 *  sub-interface gets the empty no-op (Safari has no protocol-level network tap
 *  at all, and no Page to feed the event path, so the network tools are
 *  capability-gated); chromium (CDP present) → the byte-identical CDP substrate;
 *  any remaining engine → the Playwright context-event substrate. The presence of
 *  `cdp` is the capability signal — the same one `requireCdp` and
 *  `snapshotSubstrateFor` key on — so a future CDP-bearing engine routes to the
 *  CDP substrate automatically and a non-CDP one to the event path, with no edit
 *  here. The no-Page branch runs FIRST because on such an engine `page()` is
 *  absent or throws. */
export function networkSubstrateFor(session: NetworkSubstrateCapableSession): NetworkSubstrate {
  if (!engineDeclares(session.engine, "page")) return new SafariNoopNetworkSubstrate();
  if (session.cdp) return new CdpNetworkSubstrate(session.cdp());
  const page = requirePage(session);
  return new PlaywrightNetworkSubstrate(page.context(), page, session.engine);
}
