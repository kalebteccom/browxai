import { describe, it, expect } from "vitest";
import {
  ENGINE_KINDS,
  IMPLEMENTED_ENGINES,
  EngineNotYetSupportedError,
  resolveBrowserType,
  capabilitiesFor,
  CHROMIUM_CAPABILITIES,
  requireCdp,
  type EngineKind,
} from "./index.js";

describe("engine port — EngineKind + selection", () => {
  it("commits to the three RFC engines", () => {
    expect(ENGINE_KINDS).toEqual(["chromium", "firefox", "webkit"]);
  });

  it("wires only chromium in P0", () => {
    expect(IMPLEMENTED_ENGINES).toEqual(["chromium"]);
  });

  it("resolves chromium to a Playwright BrowserType with the expected name", () => {
    const bt = resolveBrowserType("chromium");
    expect(bt.name()).toBe("chromium");
  });

  it.each(["firefox", "webkit"] as const)(
    "rejects %s with a structured engine-not-yet-supported error naming the RFC",
    (engine) => {
      let caught: unknown;
      try {
        resolveBrowserType(engine);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EngineNotYetSupportedError);
      const err = caught as EngineNotYetSupportedError;
      expect(err.engine).toBe(engine);
      expect(err.message).toContain("engine-not-yet-supported");
      expect(err.message).toContain("0002-multi-engine-bidi");
      // not a silent fallback to chromium — it throws.
      expect(err.message).toContain(engine);
    },
  );
});

describe("engine port — capability declaration", () => {
  it("chromium declares every sub-interface plus the deep (CDP) escape hatch", () => {
    const caps = capabilitiesFor("chromium");
    expect(caps).toBe(CHROMIUM_CAPABILITIES);
    expect(caps?.engine).toBe("chromium");
    expect(caps?.deep).toBe(true);
    // all nine sub-interfaces — nothing newly gated in P0.
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

  it("has no declaration for the not-yet-implemented engines", () => {
    for (const engine of ["firefox", "webkit"] as const) {
      expect(capabilitiesFor(engine)).toBeUndefined();
    }
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
