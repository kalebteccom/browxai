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
  requireCdp,
  type EngineKind,
} from "./index.js";

describe("engine port — EngineKind + selection", () => {
  it("commits to the three RFC engines", () => {
    expect(ENGINE_KINDS).toEqual(["chromium", "firefox", "webkit"]);
  });

  it("wires chromium + firefox + webkit (all three RFC engines)", () => {
    expect(IMPLEMENTED_ENGINES).toEqual(["chromium", "firefox", "webkit"]);
  });

  it.each(["chromium", "firefox", "webkit"] as const)(
    "resolves %s to a Playwright BrowserType with the expected name",
    (engine) => {
      const bt = resolveBrowserType(engine);
      expect(bt.name()).toBe(engine);
    },
  );

  it("EngineNotYetSupportedError stays structured + RFC-naming for any future engine", () => {
    // All three EngineKind members are implemented today, so resolveBrowserType
    // no longer throws for them. The error type remains the no-silent-no-op guard
    // for a future-declared engine; assert its shape directly (it names the RFC
    // and the engine, and is never a silent fallback to chromium).
    const err = new EngineNotYetSupportedError("webkit");
    expect(err).toBeInstanceOf(EngineNotYetSupportedError);
    expect(err.engine).toBe("webkit");
    expect(err.message).toContain("engine-not-yet-supported");
    expect(err.message).toContain("0002-multi-engine-bidi");
    expect(err.message).toContain("webkit");
  });
});

describe("engine port — capability declaration", () => {
  it("chromium declares every sub-interface plus the deep (CDP) escape hatch", () => {
    const caps = capabilitiesFor("chromium");
    expect(caps).toBe(CHROMIUM_CAPABILITIES);
    expect(caps?.engine).toBe("chromium");
    expect(caps?.deep).toBe(true);
    // all nine sub-interfaces — nothing newly gated on chromium.
    expect(caps?.subInterfaces.size).toBe(9);
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
    // it still serves the nine cross-browser sub-interfaces.
    expect(caps?.subInterfaces.size).toBe(9);
  });

  it("webkit declares the cross-browser sub-interfaces but NO deep (CDP) hatch", () => {
    const caps = capabilitiesFor("webkit");
    expect(caps).toBe(WEBKIT_CAPABILITIES);
    expect(caps?.engine).toBe("webkit");
    // WebKit has no CDP at all (measured: newCDPSession throws) — so the
    // capability-based engine gate auto-refuses the CDP-deep tools on it.
    expect(caps?.deep).toBe(false);
    // it still serves the nine cross-browser sub-interfaces (the walker substrate
    // + Playwright's cross-browser surface).
    expect(caps?.subInterfaces.size).toBe(9);
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
    expect(() => requireCdp(session)).toThrowError(/0002-multi-engine-bidi/);
  });
});
