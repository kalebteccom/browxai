// Operator engine selection — the BROWX_ENGINE env var + --engine CLI flag that
// make firefox/webkit/android reachable when running the MCP server. Pure over
// (argv, env): no browser, no createServer side-effect. Asserts precedence
// (flag > env > default), validation (valid passes, invalid errors with the
// engine list), and the bare-flag mistake.

import { describe, it, expect } from "vitest";
import { resolveEngineSelection, validateEngine, UnknownEngineError } from "./index.js";

describe("validateEngine — operator string → EngineKind", () => {
  it.each(["chromium", "safari"] as const)("accepts the implemented engine %s", (engine) => {
    expect(validateEngine(engine)).toBe(engine);
  });

  it("rejects an unknown engine name with the implemented-engine list", () => {
    expect(() => validateEngine("opera")).toThrow(UnknownEngineError);
    try {
      validateEngine("opera");
    } catch (e) {
      const err = e as UnknownEngineError;
      expect(err.message).toContain('engine "opera" is not available');
      expect(err.message).toContain("chromium, firefox, webkit, android, safari");
      expect(err.value).toBe("opera");
    }
  });
});

describe("resolveEngineSelection — precedence flag > env > default", () => {
  it("returns undefined when neither flag nor env is set (server applies chromium)", () => {
    expect(resolveEngineSelection([], {})).toBeUndefined();
  });

  it("reads --engine <kind> from argv", () => {
    expect(resolveEngineSelection(["--engine", "webkit"], {})).toBe("webkit");
  });

  it("reads --engine=<kind> (equals form) from argv", () => {
    expect(resolveEngineSelection(["--engine=android"], {})).toBe("android");
  });

  it("BROWX_ENGINE wins over the default but loses to the flag (full precedence chain)", () => {
    // env beats default
    expect(resolveEngineSelection([], { BROWX_ENGINE: "android" })).toBe("android");
    // flag beats env
    expect(resolveEngineSelection(["--engine=chromium"], { BROWX_ENGINE: "android" })).toBe(
      "chromium",
    );
  });

  it("trims + ignores an empty BROWX_ENGINE (falls back to default)", () => {
    expect(resolveEngineSelection([], { BROWX_ENGINE: "   " })).toBeUndefined();
    expect(resolveEngineSelection([], { BROWX_ENGINE: "" })).toBeUndefined();
  });

  it("validates the env value — an unknown BROWX_ENGINE errors with the list", () => {
    expect(() => resolveEngineSelection([], { BROWX_ENGINE: "opera" })).toThrow(UnknownEngineError);
  });

  it("a bare trailing --engine (no value) is a loud mistake, not a silent no-op", () => {
    expect(() => resolveEngineSelection(["--engine"], {})).toThrowError(
      /--engine requires a value/,
    );
    // a following flag is not swallowed as the value
    expect(() => resolveEngineSelection(["--engine", "--headless"], {})).toThrowError(
      /--engine requires a value/,
    );
  });
});
