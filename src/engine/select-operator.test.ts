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
  it.each([
    {
      label: "returns undefined when neither flag nor env is set (server applies chromium)",
      argv: [] as string[],
      env: {},
      expected: undefined,
    },
    {
      label: "reads --engine <kind> from argv",
      argv: ["--engine", "webkit"],
      env: {},
      expected: "webkit",
    },
    {
      label: "reads --engine=<kind> (equals form) from argv",
      argv: ["--engine=android"],
      env: {},
      expected: "android",
    },
    {
      label: "BROWX_ENGINE wins over the default",
      argv: [],
      env: { BROWX_ENGINE: "android" },
      expected: "android",
    },
    {
      label: "the flag wins over BROWX_ENGINE",
      argv: ["--engine=chromium"],
      env: { BROWX_ENGINE: "android" },
      expected: "chromium",
    },
    {
      label: "trims a whitespace-only BROWX_ENGINE and falls back to the default",
      argv: [],
      env: { BROWX_ENGINE: "   " },
      expected: undefined,
    },
    {
      label: "ignores an empty BROWX_ENGINE and falls back to the default",
      argv: [],
      env: { BROWX_ENGINE: "" },
      expected: undefined,
    },
  ])("$label", ({ argv, env, expected }) => {
    expect(resolveEngineSelection(argv, env)).toBe(expected);
  });

  it.each([
    {
      label: "an unknown BROWX_ENGINE errors with the list",
      argv: [] as string[],
      env: { BROWX_ENGINE: "opera" },
      error: UnknownEngineError as typeof UnknownEngineError | RegExp,
    },
    {
      label: "a bare trailing --engine (no value) is a loud mistake, not a silent no-op",
      argv: ["--engine"],
      env: {},
      error: /--engine requires a value/,
    },
    {
      label: "a following flag is not swallowed as the --engine value",
      argv: ["--engine", "--headless"],
      env: {},
      error: /--engine requires a value/,
    },
  ])("rejects: $label", ({ argv, env, error }) => {
    expect(() => resolveEngineSelection(argv, env)).toThrow(error);
  });
});
