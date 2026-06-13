import { describe, it, expect } from "vitest";
import {
  PlaywrightEmulationSubstrate,
  SafariEmulationSubstrate,
  type EmulationSubstrate,
} from "./emulation-substrate.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { BrowserContext, Page } from "playwright-core";

// The EmulationSubstrate port routing/gating. PlaywrightEmulationSubstrate wraps
// the existing `context.setGeolocation` / `page.emulateMedia` live mutators
// verbatim (covered by the per-engine keystones); these cover the live-mutation
// delegation + the Safari adapter's structured refusal that replaced the
// (previously absent) per-handler engine branch — Safari has no live-emulation
// surface beyond viewport.

function safariHandle(): SafariSessionHandle {
  return { sessionId: "S", webDriver: {} } as unknown as SafariSessionHandle;
}

describe("SafariEmulationSubstrate", () => {
  it("tags the safari engine", () => {
    expect(new SafariEmulationSubstrate(safariHandle()).engine).toBe("safari");
  });

  it("refuses set_geolocation cleanly with a chromium/firefox/webkit hint", async () => {
    const sub: EmulationSubstrate = new SafariEmulationSubstrate(safariHandle());
    const r = await sub.setGeolocation({ latitude: 1, longitude: 2 });
    expect(r.kind).toBe("refusal");
    if (r.kind !== "refusal") throw new Error("expected refusal");
    expect(r.error).toContain("set_geolocation");
    expect(r.error).toContain("Safari");
    expect(r.hint).toContain("chromium");
  });

  it("refuses clearing geolocation (null coords) too", async () => {
    const sub: EmulationSubstrate = new SafariEmulationSubstrate(safariHandle());
    const r = await sub.setGeolocation(null);
    expect(r.kind).toBe("refusal");
  });

  it("refuses set_color_scheme cleanly", async () => {
    const sub: EmulationSubstrate = new SafariEmulationSubstrate(safariHandle());
    const r = await sub.setColorScheme("dark");
    expect(r.kind).toBe("refusal");
    if (r.kind !== "refusal") throw new Error("expected refusal");
    expect(r.error).toContain("set_color_scheme");
  });

  it("refuses set_reduced_motion cleanly", async () => {
    const sub: EmulationSubstrate = new SafariEmulationSubstrate(safariHandle());
    const r = await sub.setReducedMotion("reduce");
    expect(r.kind).toBe("refusal");
    if (r.kind !== "refusal") throw new Error("expected refusal");
    expect(r.error).toContain("set_reduced_motion");
  });
});

describe("PlaywrightEmulationSubstrate", () => {
  function stubs(): {
    context: () => BrowserContext;
    page: () => Page;
    geo: Array<{ latitude: number; longitude: number; accuracy: number } | null>;
    media: Array<Record<string, unknown>>;
  } {
    const geo: Array<{ latitude: number; longitude: number; accuracy: number } | null> = [];
    const media: Array<Record<string, unknown>> = [];
    const context = (() => ({
      setGeolocation: async (
        coords: { latitude: number; longitude: number; accuracy: number } | null,
      ) => {
        geo.push(coords);
      },
    })) as unknown as () => BrowserContext;
    const page = (() => ({
      emulateMedia: async (opts: Record<string, unknown>) => {
        media.push(opts);
      },
    })) as unknown as () => Page;
    return { context, page, geo, media };
  }

  it("tags the engine it was built for (default chromium)", () => {
    const { context, page } = stubs();
    expect(new PlaywrightEmulationSubstrate(context, page).engine).toBe("chromium");
    expect(new PlaywrightEmulationSubstrate(context, page, "webkit").engine).toBe("webkit");
  });

  it("applies geolocation via context.setGeolocation (accuracy defaults to 0)", async () => {
    const { context, page, geo } = stubs();
    const sub = new PlaywrightEmulationSubstrate(context, page, "chromium");
    const r = await sub.setGeolocation({ latitude: 51.5, longitude: -0.12 });
    expect(r.kind).toBe("applied");
    expect(geo).toEqual([{ latitude: 51.5, longitude: -0.12, accuracy: 0 }]);
  });

  it("clears geolocation with null coords", async () => {
    const { context, page, geo } = stubs();
    const sub = new PlaywrightEmulationSubstrate(context, page, "chromium");
    const r = await sub.setGeolocation(null);
    expect(r.kind).toBe("applied");
    expect(geo).toEqual([null]);
  });

  it("applies the colour scheme via page.emulateMedia", async () => {
    const { context, page, media } = stubs();
    const sub = new PlaywrightEmulationSubstrate(context, page, "chromium");
    const r = await sub.setColorScheme("dark");
    expect(r.kind).toBe("applied");
    expect(media).toEqual([{ colorScheme: "dark" }]);
  });

  it("applies reduced motion via page.emulateMedia", async () => {
    const { context, page, media } = stubs();
    const sub = new PlaywrightEmulationSubstrate(context, page, "chromium");
    const r = await sub.setReducedMotion("reduce");
    expect(r.kind).toBe("applied");
    expect(media).toEqual([{ reducedMotion: "reduce" }]);
  });
});
