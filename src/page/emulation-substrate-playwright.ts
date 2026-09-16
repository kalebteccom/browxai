// PlaywrightEmulationSubstrate — the EmulationSubstrate implementation for the
// Playwright engines (chromium / firefox / webkit / android). Delegates each live
// mutation to the existing `applyGeolocation` / `clearGeolocation` /
// `applyColorScheme` / `applyReducedMotion` over the session's context/page (the
// `context`/`page` thunks capture the session entry, the same per-call access the
// handlers did before this seam). The handler keeps the `deviceEmulation` state
// mutation + the geolocation-permission warning + the result envelope; the
// substrate only performs the live mutation. No behaviour change.
//
// Dependency direction (architecture doctrine §1): tool handler →
// EmulationSubstrate (the port in `emulation-substrate-types.ts`) → this
// implementation → Playwright BrowserContext/Page. This file never imports back
// from the `emulation-substrate.js` barrel.

import type { BrowserContext, Page } from "playwright-core";
import type { ColorScheme, GeolocationCoords, ReducedMotion } from "../session/emulation.js";
import {
  applyColorScheme,
  applyGeolocation,
  applyReducedMotion,
  clearGeolocation,
} from "../session/emulation.js";
import type { EmulationResult, EmulationSubstrate } from "./emulation-substrate-types.js";

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
