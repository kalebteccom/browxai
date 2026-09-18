// Per-engine capability declarations — the ENGINE dimension that composes with
// the per-tool capability system in util/capabilities.ts. An adapter declares
// which port sub-interfaces it implements and whether it exposes the `Deep`
// (raw-CDP) escape hatch; the per-tool gate consults this to refuse a CDP-hard
// tool on an engine that can't run it.
//
// Chromium declares EVERYTHING — every sub-interface plus `deep` — so no tool
// is newly gated; that is what makes the chromium path byte-identical.
// Firefox declares the cross-browser sub-interfaces but `deep: false`: the
// Juggler build over Playwright has no raw-CDP escape hatch (`newCDPSession`
// throws on Firefox — measured), so the ~19 CDP-hard tools
// structured-refuse on it. WebKit is the same shape — all nine cross-
// browser sub-interfaces, `deep: false` (WebKit has no CDP at all — measured:
// `newCDPSession` throws "CDP session is only available in Chromium"). Android
// is the standout: it IS Chromium (attached over adb + CDP), so it declares
// `deep: true` like desktop Chromium — every tool, including the CDP-deep ones,
// works, and no new substrate is needed (the CDP substrates serve it verbatim).

import type { EngineCapabilities, EngineKind, EngineSubInterface } from "./types.js";

// The full Playwright-backed sub-interface set — every cross-browser
// sub-interface PLUS `element` (RFC 0009 P2: they all resolve elements through
// `PlaywrightElementSubstrate`) and `page` (RFC 0004 D5: they all back a real
// Playwright `Page`). Safari declares its own subset below and omits both, which
// is what its post-wire and the verify-family gate key off.
const ALL_SUB_INTERFACES: readonly EngineSubInterface[] = [
  "lifecycle",
  "navigation",
  "snapshot",
  "input",
  "network",
  "storage",
  "script",
  "emulation",
  "capture",
  "element",
  "page",
];

/** Chromium supports the whole port surface, including the CDP escape hatch.
 *  Declaring everything is what makes the chromium path byte-identical: the
 *  engine dimension is present but gates nothing. */
export const CHROMIUM_CAPABILITIES: EngineCapabilities = {
  engine: "chromium",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: true,
};

/** Firefox (Playwright's bundled Juggler build, the default cross-browser lane).
 *  It serves the same cross-browser sub-interfaces as Chromium — Playwright
 *  abstracts navigation, input, storage, script, emulation, capture, and the
 *  snapshot / network substrates (the latter two move onto Playwright-portable
 *  mechanisms) — but exposes NO `deep` (raw-CDP) escape hatch. `deep: false` is what
 *  the engine gate keys on to refuse the ~19 CDP-hard tools (perf / coverage /
 *  heap / CPU throttle / SW interception / extensions / pdf) with a hint. */
export const FIREFOX_CAPABILITIES: EngineCapabilities = {
  engine: "firefox",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: false,
};

/** WebKit (Playwright's bundled WebKit build — the WebKit-ENGINE correctness lane,
 *  NOT Safari). It serves the same nine cross-browser sub-interfaces
 *  as Chromium/Firefox (Playwright abstracts navigation, input, storage, script,
 *  emulation, capture, and the snapshot substrate — the page-side walker serves
 *  WebKit just as it serves Firefox; the network substrate ports onto Playwright
 *  events) — but exposes NO `deep` (raw-CDP) escape hatch. WebKit has no
 *  CDP at all (measured: `newCDPSession` throws "CDP session is only available in
 *  Chromium"), so `deep: false` is what the CAPABILITY-based engine gate keys on
 *  to refuse the ~26 CDP-deep tools with a hint — no per-engine gate edit. */
export const WEBKIT_CAPABILITIES: EngineCapabilities = {
  engine: "webkit",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: false,
};

/** Android (real Chrome-on-Android attached over adb + CDP). The
 *  STANDOUT among the non-chromium engines: Android Chrome speaks FULL CDP, so
 *  this engine exposes the `deep` (raw-CDP) escape hatch just like desktop
 *  Chromium — `deep: true`. That single fact is why Android needs NO new
 *  substrate: the CDP capability signal routes it through the EXISTING
 *  `CdpSnapshotSubstrate` + `CdpNetworkSubstrate` (via `snapshotSubstrateFor` /
 *  `networkSubstrateFor`, which key on CDP presence), and the capability-based
 *  engine gate auto-ALLOWS every tool (it refuses only on `deep: false`). So
 *  unlike firefox/webkit, EVERYTHING works on Android — the CDP-deep tools too
 *  (perf / coverage / heap / cpu / clock / CDP input dispatch / closed-shadow).
 *  The only Android-specific limits are launch-shape, not capability: managed /
 *  ephemeral launch isn't a thing on a phone (the adapter's launch path returns
 *  a structured `android-launch-not-supported` — Android is attach-only). */
export const ANDROID_CAPABILITIES: EngineCapabilities = {
  engine: "android",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: true,
};

/** Safari (real Safari.app over safaridriver, the FIRST non-Playwright,
 *  non-CDP engine). A curated SUBSET, not the full port:
 *  Classic owns input/capture(screenshot)/cookies + navigation + exec; experimental
 *  BiDi owns script + browsingContext nav/lifecycle/viewport + the console/nav
 *  events. NETWORK is omitted entirely — Safari has no protocol-level network tap
 *  or interception at all (worse than firefox/webkit, which get the Playwright-event
 *  substrate), so the network tools must REFUSE on Safari, not skip. EMULATION is
 *  omitted too — only `browsingContext.setViewport` works; the rest of the emulation
 *  surface (geolocation/locale/timezone/UA/network-conditions/CPU/clock) is absent,
 *  so it gates uniformly. ELEMENT is omitted (RFC 0009 P2): safaridriver resolves
 *  elements over WebDriver Classic element ids and no ElementSubstrate drives them
 *  yet, so the verify family refuses here — the same refusal it already produced
 *  when that gate read `page`, which safari also omits. `deep: false` (no CDP)
 *  gates the ~26 CDP-deep tools via the existing caps.deep gate with no per-engine
 *  edit. */
export const SAFARI_CAPABILITIES: EngineCapabilities = {
  engine: "safari",
  subInterfaces: new Set<EngineSubInterface>([
    "lifecycle",
    "navigation",
    "snapshot",
    "input",
    "storage",
    "script",
    "capture",
  ]),
  deep: false,
};

/** The one tool `electron` refuses by name. `navigate` would RUN — that is the
 *  problem. It loads a URL INTO the application's own renderer process, which is
 *  a privileged place on many Electron apps: a preload script routinely exposes
 *  IPC to the main process there, and the app's own document is often a
 *  `file://`-class origin. Putting arbitrary web content in it is the Electron
 *  remote-content hazard, and it holds however the app copes afterwards.
 *
 *  ON RECOVERY — what the measurement actually said. The first draft of this
 *  reason claimed the app never comes back. That is wrong, at least here: driving
 *  VS Code 1.122.1 / Electron 39.8.8 to `https://example.com` and then calling
 *  `goBack` restored `workbench.html` and the workbench re-rendered (172 monaco
 *  elements, title back). What is gone either way is every scrap of in-memory
 *  renderer state — open editors, unsaved buffers, the app's whole store. Whether
 *  the bootstrap survives a re-navigation at all is per-app and per-version: VS
 *  Code re-bootstraps from a document, while an app that received its state over
 *  IPC once at first load and never re-requests it comes back empty. Untested
 *  elsewhere; browxai does not have the operator's Slack to experiment on.
 *
 *  `go_back` / `go_forward` / `reload` are NOT here: they operate within the
 *  renderer's own history and are exactly what the app's own keyboard shortcuts
 *  do. `reload` on VS Code is Cmd-R, and `go_back` is what recovered the window
 *  in the measurement above. */
const ELECTRON_REFUSED_TOOLS: ReadonlyMap<string, string> = new Map([
  [
    "navigate",
    "Loading a URL into an attached Electron renderer runs that page INSIDE the " +
      "application's own renderer process, which on many Electron apps is privileged " +
      "(a preload script exposes IPC to the main process, and the app document is " +
      "often a file-class origin). browxai will not put arbitrary web content there. " +
      "It also replaces the application's document: every scrap of in-memory state — " +
      "open editors, unsaved buffers, the app's store — is gone, and whether the app " +
      "re-bootstraps at all is per-app (VS Code recovered via go_back when measured; " +
      "an app that gets its state over IPC once at startup will not). Drive the app " +
      "through its own UI instead: click / press / fill on the elements `snapshot` " +
      "and `find` return. `reload` re-loads the app's OWN document and is allowed. " +
      "To fetch a URL, open a separate chromium session " +
      '(`open_session({ engine: "chromium" })`).',
  ],
]);

/** Electron (a desktop Electron application attached over its
 *  `--remote-debugging-port`). Like android it IS Chromium and speaks FULL CDP, so
 *  it declares `deep: true` and needs no new substrate — the CDP snapshot/network
 *  substrates and the full Playwright post-wire serve it verbatim. Measured
 *  against VS Code 1.122.1 / Electron 39.8.8: `snapshot` returned a 132-line tree
 *  in 36ms, `find` ranked three real candidates with bboxes, and the `locatorFor`
 *  behind them resolved to exactly one element. 113 of 118 named refs held across
 *  two consecutive snapshots.
 *
 *  Every sub-interface is declared, including `navigation` — the renderer has a
 *  real history and `reload` / `go_back` / `go_forward` all work on it. The ONE
 *  navigation verb that must not run is `navigate`, and it is declared in
 *  `refusedTools` above rather than by dropping the sub-interface, because
 *  dropping it would refuse three working tools to gate one (and `navigation` is
 *  one of the four sub-interfaces no engine may omit).
 *
 *  The other Electron limit is not a capability but a lease shape:
 *  `Target.createTarget` answers "Not supported" (measured), so the attach pool
 *  claims pre-existing renderer targets and structured-refuses when they are all
 *  leased. That lives in the attach lane (`session/attach-pool.ts`), where the
 *  pool can name which sessions hold what. */
export const ELECTRON_CAPABILITIES: EngineCapabilities = {
  engine: "electron",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: true,
  refusedTools: ELECTRON_REFUSED_TOOLS,
};

const DECLARATIONS: Partial<Record<EngineKind, EngineCapabilities>> = {
  chromium: CHROMIUM_CAPABILITIES,
  firefox: FIREFOX_CAPABILITIES,
  webkit: WEBKIT_CAPABILITIES,
  android: ANDROID_CAPABILITIES,
  safari: SAFARI_CAPABILITIES,
  electron: ELECTRON_CAPABILITIES,
};

/** The capability declaration for an engine. Chromium + Firefox + WebKit +
 *  Android all have declarations; the partial map keeps room
 *  for engines whose adapter hasn't landed yet (returns undefined for those). */
export function capabilitiesFor(engine: EngineKind): EngineCapabilities | undefined {
  return DECLARATIONS[engine];
}
