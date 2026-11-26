import { describe, expect, it } from "vitest";
import { checkPidBinding, checkStatusBinding, wdaBuildOf } from "./device-binding.js";

describe("checkStatusBinding", () => {
  it("passes a phone whose iOS version matches, trailing .0 ignored", () => {
    expect(() => checkStatusBinding({ os: { version: "27.2.0" } }, "27.2")).not.toThrow();
  });

  it("fails closed when either version is missing", () => {
    expect(() => checkStatusBinding({}, "27.2")).toThrow(/^ios-device-wda-mismatch:/);
    expect(() => checkStatusBinding({ os: { version: "27.2" } }, undefined)).toThrow(
      /^ios-device-wda-mismatch:/,
    );
  });

  it("refuses a simulator's status even with a matching version", () => {
    expect(() =>
      checkStatusBinding({ os: { version: "27.2" }, ios: { simulatorVersion: "27.2" } }, "27.2"),
    ).toThrow(/simulator/);
  });
});

describe("checkPidBinding", () => {
  it("passes a pid the phone lists, with or without a bundle id on the row", () => {
    expect(() => checkPidBinding({ pid: 5 }, "a.b", [{ pid: 5 }])).not.toThrow();
    expect(() => checkPidBinding({ pid: 5 }, "a.b", [{ pid: 5, bundleId: "a.b" }])).not.toThrow();
  });

  it("refuses a missing pid, an unknown pid and a pid under another bundle id", () => {
    expect(() => checkPidBinding({}, "a.b", [{ pid: 5 }])).toThrow(/^ios-device-wda-mismatch:/);
    expect(() => checkPidBinding({ pid: 6 }, "a.b", [{ pid: 5 }])).toThrow(/mismatch/);
    expect(() => checkPidBinding({ pid: 5 }, "a.b", [{ pid: 5, bundleId: "c.d" }])).toThrow(
      /mismatch/,
    );
  });
});

describe("wdaBuildOf", () => {
  it("names the build version when /status has one", () => {
    expect(wdaBuildOf({ build: { version: "16.15.3" } })).toBe("build 16.15.3");
    expect(wdaBuildOf({})).toBeUndefined();
  });
});
