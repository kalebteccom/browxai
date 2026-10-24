import { describe, expect, it } from "vitest";
import { hasUserDataDir, looksLikeChrome, processCommandLine } from "./chrome-process.js";

describe("looksLikeChrome", () => {
  it.each([
    ["linux", "/opt/google/chrome/chrome --remote-debugging-port=9222 --user-data-dir=/w/profile"],
    [
      "darwin",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/Users/a/.browxai/profile",
    ],
    ["linux", "/usr/bin/chromium --user-data-dir=/w/profile"],
    ["win32", "chrome.exe"],
  ] as const)("accepts Chrome on %s: %s", (platform, cmd) => {
    expect(looksLikeChrome(cmd, platform)).toBe(true);
  });

  it.each([
    ["linux", "/usr/bin/vim /tmp/chrome --user-data-dir=/x"],
    ["linux", "/opt/google/chrome/chrome --type=renderer"],
  ] as const)("refuses on %s: %s", (platform, cmd) => {
    expect(looksLikeChrome(cmd, platform)).toBe(false);
  });
});

describe("hasUserDataDir", () => {
  it("matches the exact directory as its own argument", () => {
    expect(hasUserDataDir("chrome --user-data-dir=/w/profile --no-first-run", "/w/profile")).toBe(
      true,
    );
    expect(hasUserDataDir("chrome --user-data-dir=/w/profile", "/w/profile")).toBe(true);
    expect(hasUserDataDir("chrome --user-data-dir=/w/my profile --x", "/w/my profile")).toBe(true);
  });

  it("refuses a longer directory, a different one and another flag's value", () => {
    expect(hasUserDataDir("chrome --user-data-dir=/w/profile-other", "/w/profile")).toBe(false);
    expect(hasUserDataDir("chrome --user-data-dir=/w/profile/sub", "/w/profile")).toBe(false);
    expect(hasUserDataDir("chrome --user-data-dir=/x", "/w/profile")).toBe(false);
    expect(hasUserDataDir("chrome --x--user-data-dir=/w/profile", "/w/profile")).toBe(false);
  });

  it("finds a later match after an earlier near-miss", () => {
    const line = "chrome --user-data-dir=/w/profile-x --user-data-dir=/w/profile";
    expect(hasUserDataDir(line, "/w/profile")).toBe(true);
  });
});

describe("looksLikeChrome with a profile directory", () => {
  it("requires that directory on platforms that report arguments", () => {
    const cmd = "/opt/google/chrome/chrome --user-data-dir=/w/profile";
    expect(looksLikeChrome(cmd, "linux", "/w/profile")).toBe(true);
    expect(looksLikeChrome(cmd, "linux", "/w/profiles/work")).toBe(false);
    expect(looksLikeChrome("/opt/google/chrome/chrome", "linux", "/w/profile")).toBe(false);
  });

  it("does not check the flag on Windows, where only the image name is reported", () => {
    expect(looksLikeChrome("chrome.exe", "win32", "C:\\w\\profile")).toBe(true);
  });
});

describe("processCommandLine", () => {
  it("reads this process's own command line", () => {
    expect(processCommandLine(process.pid)).toBeTruthy();
  });

  it("returns undefined for a PID that is not a positive integer", () => {
    expect(processCommandLine(0)).toBeUndefined();
    expect(processCommandLine(-1)).toBeUndefined();
    expect(processCommandLine(Number.NaN)).toBeUndefined();
  });
});
