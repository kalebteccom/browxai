import { describe, it, expect } from "vitest";
import {
  ENGINE_KINDS,
  IMPLEMENTED_ENGINES,
  EngineNotYetSupportedError,
  resolveBrowserType,
  capabilitiesFor,
  CHROMIUM_CAPABILITIES,
  FIREFOX_CAPABILITIES,
  WEBKIT_CAPABILITIES,
  ANDROID_CAPABILITIES,
  requireCdp,
  type EngineKind,
} from "./index.js";

describe("engine port — EngineKind + selection", () => {
  it("commits to the five engines (safari is declared)", () => {
    expect(ENGINE_KINDS).toEqual(["chromium", "firefox", "webkit", "android", "safari"]);
  });

  it("wires all five engines including safari (operator-reachable, P4)", () => {
    // safari (P4) is the first non-Playwright engine: driven over safaridriver,
    // no Playwright Page (page() throws), reachable via `--engine safari` /
    // BROWX_ENGINE=safari through the no-Playwright-Page session seam.
    expect(IMPLEMENTED_ENGINES).toEqual(["chromium", "firefox", "webkit", "android", "safari"]);
  });

  it.each(["chromium", "firefox", "webkit"] as const)(
    "resolves %s to a Playwright BrowserType with the expected name",
    (engine) => {
      const bt = resolveBrowserType(engine);
      expect(bt.name()).toBe(engine);
    },
  );

  it("resolves android to the chromium BrowserType — it IS Chromium over CDP", () => {
    // Android Chrome speaks full CDP, so the adapter attaches with
    // chromium.connectOverCDP over an adb-forwarded socket — the chromium
    // BrowserType is the transport.
    expect(resolveBrowserType("android").name()).toBe("chromium");
  });

  it("EngineNotYetSupportedError stays structured + RFC-naming for any future engine", () => {
    // All three EngineKind members are implemented today, so resolveBrowserType
    // no longer throws for them. The error type remains the no-silent-no-op guard
    // for a future-declared engine; assert its shape directly (it names the RFC
    // and the engine, and is never a silent fallback to chromium).
    const err = new EngineNotYetSupportedError("webkit");
    expect(err).toBeInstanceOf(EngineNotYetSupportedError);
    expect(err.engine).toBe("webkit");
    expect(err.message).toContain("engine-not-yet-supported");
    expect(err.message).toContain("webkit");
  });
});

describe("engine port — capability declaration", () => {
  it("chromium declares every sub-interface plus the deep (CDP) escape hatch", () => {
    const caps = capabilitiesFor("chromium");
    expect(caps).toBe(CHROMIUM_CAPABILITIES);
    expect(caps?.engine).toBe("chromium");
    expect(caps?.deep).toBe(true);
    // all ten sub-interfaces — the nine cross-browser ones plus `page` (RFC 0004
    // D5: chromium backs a real Playwright Page). Nothing newly gated on chromium.
    expect(caps?.subInterfaces.size).toBe(10);
    for (const sub of [
      "lifecycle",
      "navigation",
      "snapshot",
      "input",
      "network",
      "storage",
      "script",
      "emulation",
      "capture",
      "page",
    ] as const) {
      expect(caps?.subInterfaces.has(sub)).toBe(true);
    }
  });

  it("firefox declares the cross-browser sub-interfaces but NO deep (CDP) hatch", () => {
    const caps = capabilitiesFor("firefox");
    expect(caps).toBe(FIREFOX_CAPABILITIES);
    expect(caps?.engine).toBe("firefox");
    // the headline of the capability gate: firefox has no raw-CDP escape hatch.
    expect(caps?.deep).toBe(false);
    // it still serves the nine cross-browser sub-interfaces + `page` (D5: firefox
    // backs a real Playwright Page).
    expect(caps?.subInterfaces.size).toBe(10);
    expect(caps?.subInterfaces.has("page")).toBe(true);
  });

  it("webkit declares the cross-browser sub-interfaces but NO deep (CDP) hatch", () => {
    const caps = capabilitiesFor("webkit");
    expect(caps).toBe(WEBKIT_CAPABILITIES);
    expect(caps?.engine).toBe("webkit");
    // WebKit has no CDP at all (measured: newCDPSession throws) — so the
    // capability-based engine gate auto-refuses the CDP-deep tools on it.
    expect(caps?.deep).toBe(false);
    // it still serves the nine cross-browser sub-interfaces (the walker substrate
    // + Playwright's cross-browser surface) + `page` (D5: webkit backs a real Page).
    expect(caps?.subInterfaces.size).toBe(10);
    expect(caps?.subInterfaces.has("page")).toBe(true);
  });

  it("android declares EVERYTHING incl. deep:true — the standout (it IS Chromium)", () => {
    const caps = capabilitiesFor("android");
    expect(caps).toBe(ANDROID_CAPABILITIES);
    expect(caps?.engine).toBe("android");
    // The headline behavior: real Chrome-on-Android speaks full CDP, so unlike
    // firefox/webkit it exposes the deep escape hatch — every tool works, and the
    // existing CDP substrates serve it verbatim (no new substrate).
    expect(caps?.deep).toBe(true);
    // ten sub-interfaces — the nine cross-browser ones + `page` (D5: android IS
    // Chromium, so it backs a real Playwright Page).
    expect(caps?.subInterfaces.size).toBe(10);
    expect(caps?.subInterfaces.has("page")).toBe(true);
  });
});

describe("engine port — cdp() as a capability via requireCdp", () => {
  it("returns the handle when the session exposes cdp() (chromium)", () => {
    const handle = { marker: "cdp-handle" };
    const session = { engine: "chromium" as EngineKind, cdp: () => handle as never };
    expect(requireCdp(session)).toBe(handle);
  });

  it("throws a structured, engine-naming error when cdp() is absent", () => {
    const session = { engine: "firefox" as EngineKind };
    expect(() => requireCdp(session)).toThrowError(/engine "firefox" has no CDP escape hatch/);
  });
});
