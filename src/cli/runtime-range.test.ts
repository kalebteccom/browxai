import { describe, expect, it } from "vitest";
import { satisfiesRange } from "./runtime-range.js";

describe("satisfiesRange", () => {
  it.each([
    ["22.11.0", ">=22", true],
    ["20.18.0", ">=22", false],
    ["22.11.0", ">=22.12.0", false],
    ["22.12.0", ">=22.12.0", true],
    ["v22.11.0", ">=22", true],
    ["20.19.0", "^20.19.0 || >=22.12.0", true],
    ["21.0.0", "^20.19.0 || >=22.12.0", false],
    ["22.11.0", "^20.19.0 || >=22.12.0", false],
    ["24.0.0", "^20.19.0 || >=22.12.0", true],
    ["22.11.0", ">= 22 < 23", true],
    ["23.1.0", ">=22 <23", false],
    ["22.5.1", "22.x", true],
    ["23.0.0", "22.x", false],
    ["22.5.1", "22", true],
    ["18.0.0", "16 - 20", true],
    ["20.9.9", "16 - 20", true],
    ["21.0.0", "16 - 20", false],
    ["20.1.0", "16.0.0 - 20.0.0", false],
    ["22.0.0", "*", true],
    ["22.0.0", "", true],
    ["22.0.3", "~22.0", true],
    ["22.1.0", "~22.0", false],
    ["22.11.0", "<=22", true],
    ["23.0.0", "<=22", false],
    ["22.5.0", ">22", false],
    ["23.0.0", ">22", true],
    ["22.0.1", ">22.0.0", true],
    ["0.2.5", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["22.0.0", ">=22.0.0-rc.1", true],
    ["22.11.0", "=22.11.0", true],
    ["22.11.1", "22.11.0", false],
  ])("%s against %j is %s", (version, range, want) => {
    expect(satisfiesRange(version, range)).toBe(want);
  });

  it.each([
    ["22.0.0", ">=banana"],
    ["22.0.0", "22.1.2.3"],
    ["node", ">=22"],
    ["22.0.0", "<*"],
  ])("can't read %s against %j", (version, range) => {
    expect(satisfiesRange(version, range)).toBeUndefined();
  });
});
