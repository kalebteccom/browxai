import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config.js";

describe("resolveConfig (BROWX_TEST_ATTRIBUTES)", () => {
  it("falls back to the standard set when unset", () => {
    const c = resolveConfig({ BROWX_TEST_ATTRIBUTES: undefined });
    expect(c.testAttributes).toEqual(["data-testid", "data-test", "data-cy", "data-qa"]);
  });

  it("parses a comma-separated list and trims whitespace", () => {
    const c = resolveConfig({ BROWX_TEST_ATTRIBUTES: "data-testid, data-type , data-qa " });
    expect(c.testAttributes).toEqual(["data-testid", "data-type", "data-qa"]);
  });

  it("preserves order (first match wins, per the contract)", () => {
    const c = resolveConfig({ BROWX_TEST_ATTRIBUTES: "data-type,data-testid" });
    // Order is meaningful — calling code reads first-hit.
    expect(c.testAttributes).toEqual(["data-type", "data-testid"]);
  });

  it("filters empty entries from a sloppy list", () => {
    const c = resolveConfig({ BROWX_TEST_ATTRIBUTES: "data-testid,,data-type" });
    expect(c.testAttributes).toEqual(["data-testid", "data-type"]);
  });
});
