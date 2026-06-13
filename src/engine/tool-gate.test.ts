import { describe, it, expect } from "vitest";
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

  it("allows EVERY tool on chromium — the deep escape hatch is present", () => {
    for (const tool of DEEP_TOOLS) {
      expect(assertEngineSupports(tool, "chromium")).toBeNull();
    }
  });

  it("never gates a cross-browser (class-A) tool on any engine", () => {
    for (const tool of ["navigate", "click", "fill", "screenshot", "cookies_set", "snapshot"]) {
      expect(assertEngineSupports(tool, "firefox")).toBeNull();
      expect(assertEngineSupports(tool, "chromium")).toBeNull();
    }
  });

  it("covers the audit class-B CDP-hard families", () => {
    for (const tool of [
      "perf_start",
      "coverage_start",
      "heap_snapshot",
      "cpu_emulate",
      "sw_intercept_fetch",
      "extensions_install",
      "pdf_save",
    ]) {
      expect(DEEP_TOOLS.has(tool)).toBe(true);
    }
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

  it("auto-gates webkit (deep:false) with NO per-engine gate edit — the open/closed proof", () => {
    // WEBKIT_CAPABILITIES declares deep:false, so the SAME capability-based gate
    // that refuses firefox refuses webkit — the gate keys on the deep capability,
    // not an engine name, so a third engine that drops deep is auto-gated with no
    // tool-gate.ts change. This is the open/closed-correct design the doctrine asks
    // for: a new engine = a new adapter + a capability row, zero gate edits.
    for (const tool of DEEP_TOOLS) {
      const refusal = assertEngineSupports(tool, "webkit");
      expect(refusal, `${tool} should refuse on webkit`).not.toBeNull();
      expect(refusal!.error).toContain(tool);
      expect(refusal!.error).toContain("webkit");
      expect(refusal!.hint).toContain("chromium");
      expect(refusal!.hint).toContain("engine-adapters.md");
    }
  });

  it("never gates a cross-browser (class-A) tool on webkit either", () => {
    for (const tool of ["navigate", "click", "fill", "screenshot", "cookies_set", "snapshot"]) {
      expect(assertEngineSupports(tool, "webkit")).toBeNull();
    }
  });
});
