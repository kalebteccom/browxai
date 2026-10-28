import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config.js";

describe("resolveConfig (BROWX_TEST_ATTRIBUTES)", () => {
  it.each([
    [
      "falls back to the standard set when unset",
      undefined,
      ["data-testid", "data-test", "data-cy", "data-qa"],
    ],
    [
      "parses a comma-separated list and trims whitespace",
      "data-testid, data-type , data-qa ",
      ["data-testid", "data-type", "data-qa"],
    ],
  ])("%s", (_label, raw, expected) => {
    expect(resolveConfig({ BROWX_TEST_ATTRIBUTES: raw }).testAttributes).toEqual(expected);
  });
});
