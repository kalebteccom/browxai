import { describe, expect, it } from "vitest";
import {
  deviceAllowlistFrom,
  deviceAppsFrom,
  iosTargetFrom,
  isAllowlisted,
  namedDeviceEntry,
  parseIdList,
} from "./device-config.js";

describe("iosTargetFrom", () => {
  it("defaults to simulator when unset or blank", () => {
    expect(iosTargetFrom({})).toBe("simulator");
    expect(iosTargetFrom({ BROWX_IOS_TARGET: "" })).toBe("simulator");
    expect(iosTargetFrom({ BROWX_IOS_TARGET: "  " })).toBe("simulator");
  });

  it("accepts simulator and device", () => {
    expect(iosTargetFrom({ BROWX_IOS_TARGET: "simulator" })).toBe("simulator");
    expect(iosTargetFrom({ BROWX_IOS_TARGET: " device " })).toBe("device");
  });

  it("throws on any other value, case included", () => {
    for (const v of ["Device", "phone", "devices", "sim"]) {
      expect(() => iosTargetFrom({ BROWX_IOS_TARGET: v })).toThrow(/^ios-target-invalid:/);
    }
  });
});

describe("allowlist parsing", () => {
  it("splits on commas, trims, drops empties and duplicates", () => {
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList(" , ,")).toEqual([]);
    expect(parseIdList(" a, b ,,a, c")).toEqual(["a", "b", "c"]);
  });

  it("reads the device and app lists from their variables", () => {
    const env = {
      BROWX_IOS_DEVICE_ALLOWLIST: "id-1,udid-2",
      BROWX_IOS_DEVICE_APPS: "com.acme.app",
    };
    expect(deviceAllowlistFrom(env)).toEqual(["id-1", "udid-2"]);
    expect(deviceAppsFrom(env)).toEqual(["com.acme.app"]);
  });
});

describe("isAllowlisted", () => {
  const phone = { identifier: "core-id", udid: "hw-udid" };

  it("matches the identifier or the UDID exactly", () => {
    expect(isAllowlisted(phone, ["core-id"])).toBe(true);
    expect(isAllowlisted(phone, ["hw-udid"])).toBe(true);
  });

  it("never matches a prefix, a case variant, a name or an empty list", () => {
    expect(isAllowlisted(phone, ["core"])).toBe(false);
    expect(isAllowlisted(phone, ["CORE-ID"])).toBe(false);
    expect(isAllowlisted(phone, ["Ana's iPhone"])).toBe(false);
    expect(isAllowlisted(phone, [])).toBe(false);
    expect(isAllowlisted({ identifier: "core-id" }, ["hw-udid"])).toBe(false);
  });
});

describe("namedDeviceEntry", () => {
  it("takes BROWX_IOS_DEVICE when it is on the list", () => {
    const env = { BROWX_IOS_DEVICE_ALLOWLIST: "a,b", BROWX_IOS_DEVICE: "b" };
    expect(namedDeviceEntry(env)).toBe("b");
  });

  it("refuses BROWX_IOS_DEVICE when it is off the list", () => {
    expect(namedDeviceEntry({ BROWX_IOS_DEVICE_ALLOWLIST: "a", BROWX_IOS_DEVICE: "z" })).toBe(
      undefined,
    );
  });

  it("takes the only entry when BROWX_IOS_DEVICE is unset, and none of two", () => {
    expect(namedDeviceEntry({ BROWX_IOS_DEVICE_ALLOWLIST: "a" })).toBe("a");
    expect(namedDeviceEntry({ BROWX_IOS_DEVICE_ALLOWLIST: "a,b" })).toBe(undefined);
    expect(namedDeviceEntry({})).toBe(undefined);
  });
});
