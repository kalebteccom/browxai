import { describe, expect, it } from "vitest";
import { deviceSettingsFrom, isLoopback, isSystemApp } from "./device-settings.js";

const ENV = {
  BROWX_IOS_DEVICE_ALLOWLIST: "A,B",
  BROWX_IOS_DEVICE: "B",
  BROWX_IOS_DEVICE_APPS: "com.acme.app",
  BROWX_IOS_APP_ID: "com.acme.app",
  BROWX_IOS_WDA_URL: "http://192.0.2.10:8100/",
};

describe("deviceSettingsFrom", () => {
  it("returns the named entry, the app list and a trimmed WebDriverAgent URL", () => {
    expect(deviceSettingsFrom(ENV)).toMatchObject({
      entry: "B",
      apps: ["com.acme.app"],
      appId: "com.acme.app",
      wdaUrl: "http://192.0.2.10:8100",
      schemes: [],
    });
  });

  it("reads the scheme list lowercased without colons, and refuses a bad rate limit", () => {
    expect(
      deviceSettingsFrom({ ...ENV, BROWX_IOS_DEVICE_URL_SCHEMES: "Acme:, https" }).schemes,
    ).toEqual(["acme", "https"]);
    expect(() => deviceSettingsFrom({ ...ENV, BROWX_IOS_DEVICE_MAX_INSTALLS: "many" })).toThrow(
      /^ios-device-rate-limit-invalid:/,
    );
  });

  it("refuses two listed phones with none named", () => {
    expect(() => deviceSettingsFrom({ ...ENV, BROWX_IOS_DEVICE: "" })).toThrow(
      /^ios-device-not-allowlisted:.*more than one/,
    );
  });

  it("refuses a named phone that is not on the list", () => {
    expect(() => deviceSettingsFrom({ ...ENV, BROWX_IOS_DEVICE: "C" })).toThrow(
      /^ios-device-not-allowlisted:.*not on/,
    );
  });

  it("refuses an empty app list and a missing app id", () => {
    expect(() => deviceSettingsFrom({ ...ENV, BROWX_IOS_DEVICE_APPS: "" })).toThrow(
      /^ios-device-app-not-allowed:/,
    );
    expect(() => deviceSettingsFrom({ ...ENV, BROWX_IOS_APP_ID: "" })).toThrow(
      /^ios-app-no-bundle-id:/,
    );
  });

  it("matches the app id exactly, with no prefix match", () => {
    expect(() =>
      deviceSettingsFrom({
        ...ENV,
        BROWX_IOS_DEVICE_APPS: "com.acme",
        BROWX_IOS_APP_ID: "com.acme.app",
      }),
    ).toThrow(/^ios-device-app-not-allowed:/);
  });

  it("refuses an IPv6 loopback and a non-http address", () => {
    for (const url of ["http://[::1]:8100", "ftp://192.0.2.10", "not a url"]) {
      expect(() => deviceSettingsFrom({ ...ENV, BROWX_IOS_WDA_URL: url })).toThrow(
        /^ios-device-wda-url:/,
      );
    }
  });

  it("makes a relative bundle path absolute, so it never reads as a flag", () => {
    const s = deviceSettingsFrom({ ...ENV, BROWX_IOS_APP_PATH: "-rf.app" });
    expect(s.appPath?.startsWith("/")).toBe(true);
  });
});

describe("isSystemApp", () => {
  it("is the com.apple. prefix, without regard to case", () => {
    expect(isSystemApp("com.apple.Preferences")).toBe(true);
    expect(isSystemApp("Com.Apple.x")).toBe(true);
    expect(isSystemApp("com.applesauce.app")).toBe(false);
  });
});

describe("isLoopback", () => {
  it("covers every form a URL normalises to that reaches this Mac", () => {
    for (const raw of [
      "http://127.0.0.1:8100",
      "http://127.1.2.3",
      "http://localhost",
      "http://wda.localhost",
      "http://[::1]:8100",
      "http://[::]:8100",
      "http://0.0.0.0:8100",
      "http://0:8100",
      "http://2130706433:8100",
      "http://[::ffff:127.0.0.1]:8100",
    ]) {
      expect(isLoopback(new URL(raw).hostname), raw).toBe(true);
    }
    for (const raw of ["http://192.0.2.10:8100", "http://[fe80::1]:8100", "http://phone.lan"]) {
      expect(isLoopback(new URL(raw).hostname), raw).toBe(false);
    }
  });
});

describe("app ids", () => {
  it("a mixed-case app id on the list matches", () => {
    expect(deviceSettingsFrom({ ...ENV, BROWX_IOS_APP_ID: "COM.ACME.APP" }).appId).toBe(
      "COM.ACME.APP",
    );
  });
});
