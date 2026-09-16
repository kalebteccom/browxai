// EmulationSubstrate port + result types — the engine-agnostic seam beneath the
// live device-emulation tools (`set_geolocation` / `set_color_scheme` /
// `set_reduced_motion`). A tool handler asks a substrate to mutate ONE
// live-emulation knob and gets back a universal result; an engine-specific
// implementation does the work. The handler never names Playwright, safaridriver,
// or an engine — it calls `emulationFor(e).setColorScheme(scheme)`, the same shape
// as `actionsFor(e).click(args)`.
//
// Scope: ONLY the three cross-browser, live-mutator emulation primitives — the
// ones backed by a Playwright context/page mutator (`context.setGeolocation`,
// `page.emulateMedia`) that takes effect mid-session. The CDP-only primitives
// (`set_locale` / `set_timezone` / `set_user_agent`) stay engine-gated through
// `assertEngineSupports` (they need the raw-CDP escape hatch and have no live
// off-Chromium setter), and `set_viewport` lives in the ActionSubstrate — none
// of those are this port's concern.
//
// Dependency direction (architecture doctrine §1): tool handler →
// EmulationSubstrate (this port) → implementation → Playwright | safaridriver.
// Split out of `emulation-substrate.ts` so the port module names no vendor type;
// the two implementations live in `emulation-substrate-playwright.ts` and
// `emulation-substrate-safari.ts`. Re-exported through `./emulation-substrate.js`
// so callers import unchanged. (RFC 0009 P1.)

import type { ColorScheme, GeolocationCoords, ReducedMotion } from "../session/emulation-types.js";

/** The live mutation succeeded; the handler folds the engine state into its
 *  `deviceEmulation` bag and renders the standard `applied` envelope. */
export interface EmulationApplied {
  kind: "applied";
}

/** An engine that has no live surface for this knob (Safari). The handler renders
 *  `error`/`hint` as the same failure envelope its `catch` produced pre-seam, with
 *  no `deviceEmulation` mutation — the override was never applied. */
export interface EmulationRefusal {
  kind: "refusal";
  error: string;
  hint?: string;
}

export type EmulationResult = EmulationApplied | EmulationRefusal;

/** The live-emulation capability port. One instance wraps one session's engine
 *  handle; the methods carry no engine type, so the handlers above this seam are
 *  engine-blind. Mirrors the ActionSubstrate / CaptureSubstrate shape. `null`
 *  coords clears the geolocation override. */
export interface EmulationSubstrate {
  readonly engine: string;
  setGeolocation(coords: GeolocationCoords | null): Promise<EmulationResult>;
  setColorScheme(scheme: ColorScheme): Promise<EmulationResult>;
  setReducedMotion(motion: ReducedMotion): Promise<EmulationResult>;
}
