// The EmulationSubstrate interface — the engine-agnostic seam beneath the live
// device-emulation tools (`set_geolocation` / `set_color_scheme` /
// `set_reduced_motion`). It is the emulation side of RFC 0003: a tool handler
// asks a substrate to mutate ONE live-emulation knob and gets back a universal
// result; an engine-specific implementation does the work. The handler never
// names Playwright, safaridriver, or an engine — it calls
// `emulationFor(e).setColorScheme(scheme)`, the same shape as
// `actionsFor(e).click(args)` / `captureFor(e).screenshot(req)`.
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
// EmulationSubstrate (this interface) → implementation → Playwright | safaridriver.
// Two impls today:
//   - PlaywrightEmulationSubstrate (chromium / firefox / webkit / android): wraps
//     the existing `applyGeolocation` / `clearGeolocation` / `applyColorScheme` /
//     `applyReducedMotion` over a Playwright context/page — byte-identical to the
//     pre-seam handler, so the four engines' keystones stay green unchanged. The
//     handler keeps the `deviceEmulation` state mutation + the geolocation-
//     permission warning + the result envelope; the substrate only performs the
//     live mutation.
//   - SafariEmulationSubstrate (safari): safaridriver exposes no live-emulation
//     surface beyond viewport, so all three refuse cleanly IN THE ADAPTER (the
//     gating lives here, not as an `if (e.session.safari?.())` branch in the
//     handlers — these handlers had no Safari branch and threw at `page()` /
//     `context()` before this seam). RFC 0003.

import type { BrowserContext, Page } from "playwright-core";
import type { SafariSessionHandle } from "../engine/index.js";
import type { ColorScheme, GeolocationCoords, ReducedMotion } from "../session/emulation.js";
import {
  applyColorScheme,
  applyGeolocation,
  applyReducedMotion,
  clearGeolocation,
} from "../session/emulation.js";

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

/** Playwright engines — delegates each live mutation to the existing emulation
 *  appliers over the session's context/page (the `context`/`page` thunks capture
 *  the session entry, the same per-call access the handlers did before this seam).
 *  No behaviour change. */
export class PlaywrightEmulationSubstrate implements EmulationSubstrate {
  readonly engine: string;
  constructor(
    private readonly context: () => BrowserContext,
    private readonly page: () => Page,
    engine = "chromium",
  ) {
    this.engine = engine;
  }

  async setGeolocation(coords: GeolocationCoords | null): Promise<EmulationResult> {
    if (coords === null) await clearGeolocation(this.context());
    else await applyGeolocation(this.context(), coords);
    return { kind: "applied" };
  }

  async setColorScheme(scheme: ColorScheme): Promise<EmulationResult> {
    await applyColorScheme(this.page(), scheme);
    return { kind: "applied" };
  }

  async setReducedMotion(motion: ReducedMotion): Promise<EmulationResult> {
    await applyReducedMotion(this.page(), motion);
    return { kind: "applied" };
  }
}

/** Safari — no live-emulation surface beyond viewport. safaridriver (WebDriver
 *  Classic) has no geolocation / `prefers-color-scheme` / `prefers-reduced-motion`
 *  mutator, so all three refuse cleanly here — the gating is in the adapter, not
 *  the handler. These handlers had NO Safari branch pre-seam (they threw at
 *  `page()` / `context()`); the structured refusal replaces that crash. RFC 0003. */
export class SafariEmulationSubstrate implements EmulationSubstrate {
  readonly engine = "safari";
  constructor(_handle: SafariSessionHandle) {}

  setGeolocation(): Promise<EmulationResult> {
    return Promise.resolve(this.refuse("set_geolocation"));
  }

  setColorScheme(): Promise<EmulationResult> {
    return Promise.resolve(this.refuse("set_color_scheme"));
  }

  setReducedMotion(): Promise<EmulationResult> {
    return Promise.resolve(this.refuse("set_reduced_motion"));
  }

  private refuse(tool: string): EmulationRefusal {
    return {
      kind: "refusal",
      error: `\`${tool}\` is not supported on the Safari engine — safaridriver exposes no live-emulation surface beyond viewport.`,
      hint: "Use a chromium, firefox, or webkit session for live geolocation / colour-scheme / reduced-motion overrides.",
    };
  }
}
