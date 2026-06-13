// Per-engine capability declarations — the ENGINE dimension that composes with
// the per-tool capability system in util/capabilities.ts. An adapter declares
// which port sub-interfaces it implements and whether it exposes the `Deep`
// (raw-CDP) escape hatch; the per-tool gate consults this to refuse a CDP-hard
// tool on an engine that can't run it.
//
// Chromium declares EVERYTHING — every sub-interface plus `deep` — so no tool
// is newly gated; that is what makes the chromium path byte-identical.
// Firefox (P1) declares the cross-browser sub-interfaces but `deep: false`: the
// Juggler build over Playwright has no raw-CDP escape hatch (`newCDPSession`
// throws on Firefox — measured), so the ~19 CDP-hard tools (audit class B)
// structured-refuse on it. WebKit (P2c) is the same shape — all nine cross-
// browser sub-interfaces, `deep: false` (WebKit has no CDP at all — measured:
// `newCDPSession` throws "CDP session is only available in Chromium"). Android
// (P3) is the standout: it IS Chromium (attached over adb + CDP), so it declares
// `deep: true` like desktop Chromium — every tool, including the CDP-deep ones,
// works, and no new substrate is needed (the CDP substrates serve it verbatim).

import type { EngineCapabilities, EngineKind, EngineSubInterface } from "./types.js";

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
];

/** Chromium supports the whole port surface, including the CDP escape hatch.
 *  Declaring everything is what makes P0 byte-identical: the engine dimension
 *  is present but gates nothing. */
export const CHROMIUM_CAPABILITIES: EngineCapabilities = {
  engine: "chromium",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: true,
};

/** Firefox (Playwright's bundled Juggler build, the P1 default lane). It serves
 *  the same cross-browser sub-interfaces as Chromium — Playwright abstracts
 *  navigation, input, storage, script, emulation, capture, and the snapshot /
 *  network substrates (the latter two move onto Playwright-portable mechanisms
 *  in P2) — but exposes NO `deep` (raw-CDP) escape hatch. `deep: false` is what
 *  the engine gate keys on to refuse the ~19 CDP-hard tools (perf / coverage /
 *  heap / CPU throttle / SW interception / extensions / pdf) with a hint. */
export const FIREFOX_CAPABILITIES: EngineCapabilities = {
  engine: "firefox",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: false,
};

/** WebKit (Playwright's bundled WebKit build — the WebKit-ENGINE correctness lane
 *  per RFC D7, NOT Safari). It serves the same nine cross-browser sub-interfaces
 *  as Chromium/Firefox (Playwright abstracts navigation, input, storage, script,
 *  emulation, capture, and the snapshot substrate — the page-side walker serves
 *  WebKit just as it serves Firefox; the network substrate ports onto Playwright
 *  events in P2b) — but exposes NO `deep` (raw-CDP) escape hatch. WebKit has no
 *  CDP at all (measured: `newCDPSession` throws "CDP session is only available in
 *  Chromium"), so `deep: false` is what the CAPABILITY-based engine gate keys on
 *  to refuse the ~26 CDP-deep tools with a hint — no per-engine gate edit. */
export const WEBKIT_CAPABILITIES: EngineCapabilities = {
  engine: "webkit",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: false,
};

/** Android (P3 — real Chrome-on-Android attached over adb + CDP, RFC D3/D8). The
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

const DECLARATIONS: Partial<Record<EngineKind, EngineCapabilities>> = {
  chromium: CHROMIUM_CAPABILITIES,
  firefox: FIREFOX_CAPABILITIES,
  webkit: WEBKIT_CAPABILITIES,
  android: ANDROID_CAPABILITIES,
};

/** The capability declaration for an engine. Chromium (P0) + Firefox (P1) +
 *  WebKit (P2c) + Android (P3) all have declarations; the partial map keeps room
 *  for engines whose adapter hasn't landed yet (returns undefined for those). */
export function capabilitiesFor(engine: EngineKind): EngineCapabilities | undefined {
  return DECLARATIONS[engine];
}
