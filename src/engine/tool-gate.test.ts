import { describe, it, expect } from "vitest";
// RFC 0004 P2: DEEP_TOOLS is now DERIVED from the colocated `host.register({ deep })`
// metadata (collected by the tools-layer bootstrap). This standalone gate test
// loads the bootstrap so the lazy collector is installed and the set is populated.
import "../tools/tool-metadata.js";
import { assertEngineSupports, DEEP_TOOLS } from "./tool-gate.js";

describe("engine tool-gate — the CDP-deep refusal (firefox)", () => {
  it("refuses every deep tool on firefox with a structured, engine-naming hint", () => {
    for (const tool of DEEP_TOOLS) {
      const refusal = assertEngineSupports(tool, "firefox");
      expect(refusal, `${tool} should refuse on firefox`).not.toBeNull();
      expect(refusal!.error).toContain(tool);
      expect(refusal!.error).toContain("firefox");
      // every hint routes the agent to chromium + the matrix doc.
      expect(refusal!.hint).toContain("chromium");
      expect(refusal!.hint).toContain("engine-adapters.md");
    }
  });

  it("never gates a cross-browser (class-A) tool on any engine", () => {
    for (const tool of ["navigate", "click", "fill", "screenshot", "cookies_set", "snapshot"]) {
      expect(assertEngineSupports(tool, "firefox")).toBeNull();
      expect(assertEngineSupports(tool, "chromium")).toBeNull();
    }
  });

  it("does not engine-gate the network tools off Chromium (P2b — Playwright substrate)", () => {
    // P2b ported the network/WS tap + body fetch onto Playwright context events
    // (PlaywrightNetworkSubstrate), so these read off the portable event surface,
    // not CDP. They must NOT be in DEEP_TOOLS and must not refuse on the non-CDP
    // engines (firefox + webkit both ride the same engine-agnostic substrate).
    for (const tool of ["network_read", "ws_read", "network_body"]) {
      expect(DEEP_TOOLS.has(tool), `${tool} must not be in DEEP_TOOLS`).toBe(false);
      expect(assertEngineSupports(tool, "firefox"), `${tool} must run on firefox`).toBeNull();
      expect(assertEngineSupports(tool, "webkit"), `${tool} must run on webkit`).toBeNull();
      expect(assertEngineSupports(tool, "chromium")).toBeNull();
    }
    // The service-worker fetch interceptor stays CDP-only (Fetch.* on the SW
    // target) — it remains gated off Chromium after P2b.
    expect(DEEP_TOOLS.has("sw_intercept_fetch"), "sw_intercept_fetch stays gated").toBe(true);
    expect(assertEngineSupports("sw_intercept_fetch", "firefox")).not.toBeNull();
    expect(assertEngineSupports("sw_intercept_fetch", "webkit")).not.toBeNull();
  });

  it("carries the three D6-reclassified reasons", () => {
    // network_emulate → refuse-pending (spec'd over BiDi, not implemented)
    expect(assertEngineSupports("network_emulate", "firefox")!.hint).toContain("refuse-pending");
    // set_user_agent → no live Playwright UA setter; point at context-creation UA
    expect(assertEngineSupports("set_user_agent", "firefox")!.hint).toContain(
      "open_session({ device: { userAgent",
    );
    // pdf_save → page.pdf() is Headless-Chromium-only
    expect(assertEngineSupports("pdf_save", "firefox")!.hint).toContain("Headless-Chromium-only");
  });
});
