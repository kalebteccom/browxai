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

/** ios-app (the iOS Simulator over XCUITest — the FIRST native-app engine, and the
 *  first with no document at all). A curated SUBSET, and each omission is a thing
 *  the platform genuinely does not have rather than a thing not written yet:
 *
 *  DECLARED. `lifecycle` (boot / install / launch / terminate over `simctl`),
 *  `navigation` (deep links — `simctl openurl`; there is no address bar and no
 *  history stack), `snapshot` (the XCUITest accessibility hierarchy, which is
 *  richer than a DOM walk), `input` (tap, element-scoped set-value, key input,
 *  scroll, and swipe and pinch as real XCUITest primitives), `capture`
 *  (`simctl io screenshot`) and `element` — the native engines are what RFC 0009
 *  P2 split `element` from `page` FOR, and the verify family runs here.
 *
 *  OMITTED. `page`: there is no Playwright `Page`, no document and no frame tree.
 *  `network`: there is no protocol-level tap on a native app without a system
 *  proxy or a VPN profile, and installing either is the operator's decision.
 *  `storage`: cookies / localStorage / IndexedDB / the Cache API are
 *  document-scoped web-platform stores. `script`: a release-configuration app has
 *  no scriptable context, and reaching into a development bridge would be a
 *  different trust posture. `emulation`: geolocation, appearance and reduced
 *  motion are DEVICE settings that outlive the session, not per-session overrides.
 *
 *  `deep: false` — no CDP — gates the CDP-deep tools through the existing
 *  `caps.deep` gate with no per-engine edit. */
export const IOS_APP_CAPABILITIES: EngineCapabilities = {
  engine: "ios-app",
  subInterfaces: new Set<EngineSubInterface>([
    "lifecycle",
    "navigation",
    "snapshot",
    "input",
    "capture",
    "element",
  ]),
  deep: false,
};

const DECLARATIONS: Partial<Record<EngineKind, EngineCapabilities>> = {
  chromium: CHROMIUM_CAPABILITIES,
  firefox: FIREFOX_CAPABILITIES,
  webkit: WEBKIT_CAPABILITIES,
  android: ANDROID_CAPABILITIES,
  safari: SAFARI_CAPABILITIES,
  "ios-app": IOS_APP_CAPABILITIES,
};

/** The capability declaration for an engine. Chromium + Firefox + WebKit +
 *  Android all have declarations; the partial map keeps room
 *  for engines whose adapter hasn't landed yet (returns undefined for those). */
export function capabilitiesFor(engine: EngineKind): EngineCapabilities | undefined {
  return DECLARATIONS[engine];
}
