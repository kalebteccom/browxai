import { describe, it, expect } from "vitest";
import {
  IMPLEMENTED_ENGINES,
  EngineNotYetSupportedError,
  resolveBrowserType,
  capabilitiesFor,
  CHROMIUM_CAPABILITIES,
  requireCdp,
  type EngineKind,
} from "./index.js";

describe("engine port — EngineKind + selection", () => {
  it("wires all eight engines — safari, both native, and electron", () => {
    // safari is the first non-Playwright engine: driven over safaridriver, no
    // Playwright Page, reachable via `--engine safari` / BROWX_ENGINE=safari
    // through the no-Playwright-Page session seam. `ios-app` and `android-app`
    // (RFC 0008) are the NON-BROWSER engines, with no document at all: an app on
    // the iOS Simulator over XCUITest and an app on an Android emulator over adb.
    // Both are gated behind the off-by-default `native-device` capability at
    // session creation. `electron` is a running desktop Electron app attached
    // over its --remote-debugging-port; attach-only, full CDP, and the desktop
    // attach lane also resolves it from the protocol without the operator naming
    // it.
    expect(IMPLEMENTED_ENGINES).toEqual([
      "chromium",
      "firefox",
      "webkit",
      "android",
      "safari",
      "ios-app",
      "android-app",
      "electron",
    ]);
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
    // all eleven sub-interfaces — the nine cross-browser ones plus `page` (RFC
    // 0004 D5: chromium backs a real Playwright Page) and `element` (RFC 0009 P2:
    // it resolves elements through PlaywrightElementSubstrate). Nothing newly
    // gated on chromium.
    expect(caps?.subInterfaces.size).toBe(11);
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
      "element",
      "page",
    ] as const) {
      expect(caps?.subInterfaces.has(sub)).toBe(true);
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
  });
});
