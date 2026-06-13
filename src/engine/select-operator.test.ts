// Operator engine selection — the BROWX_ENGINE env var + --engine CLI flag that
// make firefox/webkit/android reachable when running the MCP server. Pure over
// (argv, env): no browser, no createServer side-effect. Asserts precedence
// (flag > env > default), validation (valid passes, invalid errors with the
// engine list), and the bare-flag mistake.

import { describe, it, expect } from "vitest";
import {
  resolveEngineSelection,
  validateEngine,
  UnknownEngineError,
  IMPLEMENTED_ENGINES,
} from "./index.js";

describe("validateEngine — operator string → EngineKind", () => {
  it.each(["chromium", "firefox", "webkit", "android"] as const)(
    "accepts the implemented engine %s",
    (engine) => {
      expect(validateEngine(engine)).toBe(engine);
    },
  );

  it("rejects an unimplemented-but-named engine (safari) with the RFC pointer", () => {
    expect(() => validateEngine("safari")).toThrow(UnknownEngineError);
    try {
      validateEngine("safari");
    } catch (e) {
      const err = e as UnknownEngineError;
      expect(err.message).toContain('engine "safari" is not available');
      expect(err.message).toContain("chromium, firefox, webkit, android");
      expect(err.message).toContain("RFC 0002");
      expect(err.value).toBe("safari");
    }
  });

  it("rejects a typo with the implemented-engine list (the fix is in the error)", () => {
    expect(() => validateEngine("chrome")).toThrowError(
      /engine "chrome" is not available; implemented engines: chromium, firefox, webkit, android/,
    );
  });

  it("is case-sensitive — Firefox is NOT firefox (masking a misconfig is worse)", () => {
    expect(() => validateEngine("Firefox")).toThrow(UnknownEngineError);
  });
});

describe("resolveEngineSelection — precedence flag > env > default", () => {
  it("returns undefined when neither flag nor env is set (server applies chromium)", () => {
    expect(resolveEngineSelection([], {})).toBeUndefined();
  });

  it("reads BROWX_ENGINE from the env when no flag is present", () => {
    expect(resolveEngineSelection([], { BROWX_ENGINE: "firefox" })).toBe("firefox");
  });

  it("reads --engine <kind> from argv", () => {
    expect(resolveEngineSelection(["--engine", "webkit"], {})).toBe("webkit");
  });

  it("reads --engine=<kind> (equals form) from argv", () => {
    expect(resolveEngineSelection(["--engine=android"], {})).toBe("android");
  });

  it("the explicit --engine flag WINS over BROWX_ENGINE", () => {
    expect(resolveEngineSelection(["--engine", "webkit"], { BROWX_ENGINE: "firefox" })).toBe(
      "webkit",
    );
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
    expect(() => resolveEngineSelection([], { BROWX_ENGINE: "safari" })).toThrow(
      UnknownEngineError,
    );
  });

  it("validates the flag value — an unknown --engine errors with the list", () => {
    expect(() => resolveEngineSelection(["--engine", "safari"], {})).toThrow(UnknownEngineError);
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

  it("an implemented non-default engine threads through unchanged (the createServer opt)", () => {
    // This is the value cli.ts hands to createServer({ browserType }). For every
    // implemented non-default engine it round-trips the operator's choice exactly.
    for (const engine of IMPLEMENTED_ENGINES) {
      if (engine === "chromium") continue;
      expect(resolveEngineSelection([`--engine=${engine}`], {})).toBe(engine);
      expect(resolveEngineSelection([], { BROWX_ENGINE: engine })).toBe(engine);
    }
  });

  it("ignores unrelated argv tokens around the flag", () => {
    expect(resolveEngineSelection(["doctor", "--engine", "firefox", "--verbose"], {})).toBe(
      "firefox",
    );
  });
});
