import { describe, expect, it } from "vitest";
import { looksLikeChrome, processCommandLine } from "./chrome-process.js";

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
    ["linux", "/usr/bin/python3 -m http.server"],
    ["linux", "/opt/google/chrome/chrome --type=renderer"],
    ["darwin", "/bin/zsh -l"],
    ["win32", "notepad.exe"],
  ] as const)("refuses on %s: %s", (platform, cmd) => {
    expect(looksLikeChrome(cmd, platform)).toBe(false);
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
