import { describe, expect, it } from "vitest";
import { appVerdict } from "./device-app-policy.js";

const APPS = ["com.acme.app", "com.apple.Preferences"];

describe("appVerdict", () => {
  it("allows a listed app for every verb", () => {
    for (const verb of ["launch", "install", "terminate"] as const) {
      expect(appVerdict(verb, "com.acme.app", APPS).kind).toBe("allow");
    }
  });

  it("asks a person to launch a listed system app, every time, and lets it be stopped", () => {
    expect(appVerdict("launch", "com.apple.Preferences", APPS).kind).toBe("confirm");
    expect(appVerdict("terminate", "com.apple.Preferences", APPS).kind).toBe("allow");
  });

  it("refuses an unlisted system app for every verb", () => {
    for (const verb of ["launch", "install", "terminate"] as const) {
      const v = appVerdict(verb, "com.apple.MobileSMS", APPS);
      expect(v.kind).toBe("refuse");
      if (v.kind === "refuse") expect(v.error.code).toBe("ios-device-system-app");
    }
  });

  it("asks a person to launch or install an unlisted app, and refuses to stop one", () => {
    expect(appVerdict("launch", "com.bank.app", APPS).kind).toBe("confirm");
    expect(appVerdict("install", "com.bank.app", APPS).kind).toBe("confirm");
    const v = appVerdict("terminate", "com.bank.app", APPS);
    expect(v.kind === "refuse" && v.error.code).toBe("ios-device-app-not-allowed");
  });
});
