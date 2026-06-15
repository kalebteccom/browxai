// The BrowserEngine port — the seam beneath the session layer that lets browxai
// drive engines other than Chromium without rewriting the ~139 tools that
// already speak only Playwright's cross-browser surface. See
// docs/ai-context/architecture/engine-adapters.md for the strangler-fig design.
//
// Today Chromium is the only implemented engine. The port exists so the second
// engine (Firefox) lands as a new adapter, not a core rewrite — the proven-seam
// test in architecture-principles.md is satisfied because Firefox/WebKit are the
// committed next engines and every coupling seam is already named.

import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

/** The browser engines this port targets. chromium / firefox / webkit are the
 *  desktop engines. `android` is real Chrome-on-Android attached
 *  over adb + CDP — it IS Chromium, so it reuses the CDP substrates verbatim and
 *  declares `deep: true` (every tool, including the CDP-deep ones, works). It is
 *  a DISTINCT kind, not `chromium`, because its launch model is attach-only
 *  (adb socket discovery → `connectOverCDP`) and managed/ephemeral launch on a
 *  phone is not a thing the desktop adapters' shape covers. */
// `safari` is the FIRST non-Playwright engine: real Safari.app driven over
// safaridriver (WebDriver Classic workhorse + experimental BiDi for console/nav
// events), non-BYOB isolated automation windows. It has NO Playwright Page and NO
// CDP, so its session is Safari-native and drives the engine entirely through the
// no-Playwright-Page seam.
export type EngineKind = "chromium" | "firefox" | "webkit" | "android" | "safari";

export const ENGINE_KINDS: readonly EngineKind[] = [
  "chromium",
  "firefox",
  "webkit",
  "android",
  "safari",
];

/** Capability-segregated sub-interfaces of the port. An adapter declares which
 *  ones it supports via `EngineCapabilities`; a tool that needs `deep` (CDP) is
 *  refused on an engine that lacks it through the existing capability gate.
 *
 *  The method set is derived from what the session layer + tools ACTUALLY call
 *  today — interface segregation means each sub-interface is only what real
 *  callers need, not a speculative superset.
 *
 *  Today the live port surface is intentionally thin: the session layer is the
 *  only consumer, so the port exposes the lifecycle handles the rest of the
 *  server already builds on (`Page`, `BrowserContext`, optional `CDPSession`).
 *  The sub-interface NAMES below are the typed map of where each engine-specific
 *  behavior lives as adapters grow; they are documented on
 *  `EngineCapabilities`, not yet split into separate method bundles, because
 *  splitting before the second adapter exists would be the speculative
 *  generality the doctrine forbids. */
export type EngineSubInterface =
  | "lifecycle"
  | "navigation"
  | "snapshot"
  | "input"
  | "network"
  | "storage"
  | "script"
  | "emulation"
  | "capture"
  // The Playwright-`Page` capability (RFC 0004 D5). Present iff the engine backs
  // a session with a real Playwright `Page` (chromium / firefox / webkit /
  // android); ABSENT on safari (no-Playwright-Page). Declaring page-availability
  // is what closes the Safari LSP leak: a no-Page engine omits this sub-interface
  // and its post-wire skips every Playwright-only step, so no caller reaches the
  // `page()`-throws fallback — replacing the 17 scattered `!== "safari"` guards.
  | "page";

/** Declares what an adapter supports. Composes with the existing per-tool
 *  capability system (util/capabilities.ts) — this is the ENGINE dimension.
 *  Chromium declares every sub-interface plus `deep`, so nothing is newly gated
 *  today. An adapter that lacks `deep` (no CDP escape hatch) declares
 *  `deep: false`; the ~19 CDP-hard tools are then refused on it
 *  through the capability gate, not by throwing a vague error mid-call. */
export interface EngineCapabilities {
  readonly engine: EngineKind;
  /** Sub-interfaces this adapter implements. Chromium: all of them. */
  readonly subInterfaces: ReadonlySet<EngineSubInterface>;
  /** Whether the adapter exposes the `Deep` (raw-CDP) escape hatch — the typed
   *  home for the ~19 CDP-hard operations. Chromium: true. Firefox/WebKit will
   *  declare false and gate those tools. */
  readonly deep: boolean;
}

/** A live engine-backed session. The adapter owns engine selection + launch;
 *  the rest of the server consumes these handles exactly as it did before the
 *  seam existed — `page()` / `context()` are the cross-browser surface, `cdp()`
 *  is the engine-specific (Chromium) escape hatch and is now OPTIONAL.
 *
 *  `cdp()` was a mandatory member of `BrowserSession`; that single line hard-
 *  gated multi-engine because `newCDPSession` throws off-Chromium. It is now a
 *  capability the adapter exposes: present + fully functional on Chromium,
 *  absent on engines without CDP. Consumers that need it go through
 *  `requireCdp()` (see ./session-cdp.ts), which asserts presence with a
 *  structured, engine-naming error — never a silent failure. */
export interface EngineSession {
  readonly engine: EngineKind;
  readonly capabilities: EngineCapabilities;
  page(): Page;
  context(): BrowserContext;
  /** Raw CDP handle. Present only when `capabilities.deep` is true (Chromium).
   *  Undefined on engines without a CDP escape hatch. */
  cdp?(): CDPSession;
  close(): Promise<void>;
}

/** Internal handles an adapter wires up at launch, before the session-layer
 *  bookkeeping (buffers, bridge, policies) attaches to them. */
export interface EngineLaunchHandles {
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  cdp?: CDPSession;
}
