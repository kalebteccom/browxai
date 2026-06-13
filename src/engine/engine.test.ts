import { describe, it, expect } from "vitest";
import {
  ENGINE_KINDS,
  IMPLEMENTED_ENGINES,
  EngineNotYetSupportedError,
  resolveBrowserType,
  capabilitiesFor,
  CHROMIUM_CAPABILITIES,
  FIREFOX_CAPABILITIES,
  requireCdp,
  type EngineKind,
} from "./index.js";

describe("engine port — EngineKind + selection", () => {
  it("commits to the three RFC engines", () => {
    expect(ENGINE_KINDS).toEqual(["chromium", "firefox", "webkit"]);
  });

  it("wires chromium + firefox; webkit is still pending", () => {
    expect(IMPLEMENTED_ENGINES).toEqual(["chromium", "firefox"]);
  });

  it.each(["chromium", "firefox"] as const)(
    "resolves %s to a Playwright BrowserType with the expected name",
    (engine) => {
      const bt = resolveBrowserType(engine);
      expect(bt.name()).toBe(engine);
    },
  );

  it("rejects webkit with a structured engine-not-yet-supported error naming the RFC", () => {
    let caught: unknown;
    try {
      resolveBrowserType("webkit");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineNotYetSupportedError);
    const err = caught as EngineNotYetSupportedError;
    expect(err.engine).toBe("webkit");
    expect(err.message).toContain("engine-not-yet-supported");
    expect(err.message).toContain("0002-multi-engine-bidi");
    // not a silent fallback to chromium — it throws, naming the engine.
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

  it("has no declaration for webkit (its adapter hasn't landed yet)", () => {
    expect(capabilitiesFor("webkit")).toBeUndefined();
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
