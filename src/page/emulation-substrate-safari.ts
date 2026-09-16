// SafariEmulationSubstrate — no live-emulation surface beyond viewport.
// safaridriver (WebDriver Classic) has no geolocation / `prefers-color-scheme` /
// `prefers-reduced-motion` mutator, so all three refuse cleanly here — the gating
// is in the adapter, not the handler. These handlers had NO Safari branch
// pre-seam (they threw at `page()` / `context()`); the structured refusal replaces
// that crash.
//
// Dependency direction (architecture doctrine §1): tool handler →
// EmulationSubstrate (the port in `emulation-substrate-types.ts`) → this
// implementation → safaridriver. This file never imports back from the
// `emulation-substrate.js` barrel.

import type { SafariSessionHandle } from "../engine/index.js";
import type {
  EmulationRefusal,
  EmulationResult,
  EmulationSubstrate,
} from "./emulation-substrate-types.js";

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
