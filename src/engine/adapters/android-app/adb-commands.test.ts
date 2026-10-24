// The pure adb layer: argv construction, the device-shell quoting chokepoint,
// and the output parsers. No device, no binary, no clock.

import { describe, it, expect } from "vitest";
import {
  deepLinkArgs,
  dumpHierarchyArgs,
  forceStopArgs,
  installArgs,
  installFailure,
  inputTextArgs,
  isEmulatorSerial,
  keyEventArgs,
  listPackagesArgs,
  motionEventArgs,
  parseAvds,
  parseForeground,
  parsePackages,
  parseResolvedActivity,
  parseScreenSize,
  screencapArgs,
  shellQuote,
  stripDumpTrailer,
  swipeArgs,
  tapArgs,
} from "./adb-commands.js";

describe("shellQuote — the device-shell chokepoint", () => {
  // `adb shell <words…>` joins its argv and hands the result to the DEVICE's
  // `sh`. Everything below would be interpreted there without quoting, and
  // `fill` / `press` are the tools that carry agent-supplied text into it.
  it.each([
    // The one character that can escape single quotes: `it's` must not become
    // `'it'` followed by a bare `s`.
    { label: "splices an embedded single quote", input: "it's", expected: `'it'\\''s'` },
    { label: "neutralises a command separator", input: "a; reboot", expected: "'a; reboot'" },
    // An unwrapped empty value would VANISH from the argv and shift every later word.
    { label: "wraps the empty string", input: "", expected: "''" },
  ])("shellQuote: $label", ({ input, expected }) => {
    expect(shellQuote(input)).toBe(expected);
  });
});

describe("argv construction", () => {
  it.each([
    {
      label: "scopes tap to the serial",
      actual: tapArgs(10, 20, "emulator-5554").slice(0, 2),
      expected: ["-s", "emulator-5554"],
    },
    {
      label: "scopes the hierarchy dump to the serial",
      actual: dumpHierarchyArgs("emulator-5554").slice(0, 2),
      expected: ["-s", "emulator-5554"],
    },
    // `shell screencap` corrupts a PNG by translating LF to CRLF on some transports.
    {
      label: "screencap uses exec-out",
      actual: screencapArgs(),
      expected: ["exec-out", "screencap", "-p"],
    },
    {
      label: "hierarchy dump uses exec-out",
      actual: dumpHierarchyArgs(),
      expected: ["exec-out", "uiautomator", "dump", "/dev/tty"],
    },
    {
      label: "rounds coordinates because `input` takes integers",
      actual: tapArgs(10.6, 20.4),
      expected: ["shell", "input", "tap", "11", "20"],
    },
    // Duration is what separates a swipe from a drag to the platform's gesture detectors.
    {
      label: "always sends a swipe duration",
      actual: swipeArgs({ x: 1, y: 2 }, { x: 3, y: 4 }, 300),
      expected: ["shell", "input", "swipe", "1", "2", "3", "4", "300"],
    },
    {
      label: "builds a motionevent per phase",
      actual: motionEventArgs("DOWN", 5, 6),
      expected: ["shell", "input", "motionevent", "DOWN", "5", "6"],
    },
    {
      label: "quotes agent-supplied text",
      actual: inputTextArgs("a; reboot"),
      expected: ["shell", "input", "text", "'a;%sreboot'"],
    },
    {
      label: "quotes key names",
      actual: keyEventArgs("KEYCODE_BACK"),
      expected: ["shell", "input", "keyevent", "'KEYCODE_BACK'"],
    },
    // `adb install` runs host-side: quoting the path would make adb look for a
    // file whose name has quotes.
    {
      label: "passes a HOST apk path unquoted",
      actual: installArgs("/tmp/a b.apk", false),
      expected: ["install", "/tmp/a b.apk"],
    },
    {
      label: "adds -r for a reinstall",
      actual: installArgs("/tmp/a.apk", true),
      expected: ["install", "-r", "/tmp/a.apk"],
    },
    // `am kill` silently no-ops on the foreground app.
    {
      label: "force-stops rather than kills",
      actual: forceStopArgs("com.acme.app").includes("force-stop"),
      expected: true,
    },
    {
      label: "restricts the package list to third-party",
      actual: listPackagesArgs(true),
      expected: ["shell", "pm", "list", "packages", "-3"],
    },
    {
      label: "lists every package when not restricted",
      actual: listPackagesArgs(false),
      expected: ["shell", "pm", "list", "packages"],
    },
    {
      label: "opens a deep link as a VIEW intent",
      actual: deepLinkArgs("myapp://checkout/42"),
      expected: [
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "'myapp://checkout/42'",
      ],
    },
  ])("argv: $label", ({ actual, expected }) => {
    expect(actual).toEqual(expected);
  });
});

describe("parsers", () => {
  const CURRENT =
    "  mCurrentFocus=Window{7f64b6a u0 app.controlplus/com.webverif.MainActivity}\n" +
    "  mFocusedApp=ActivityRecord{fc1e8d6 u0 app.controlplus/com.webverif.MainActivity t9}";

  it.each([
    {
      label: "stripDumpTrailer cuts the status line UiAutomator appends after the XML",
      actual: stripDumpTrailer(
        '<hierarchy rotation="0"><node /></hierarchy>UI hierchary dumped to: /dev/tty',
      ),
      expected: '<hierarchy rotation="0"><node /></hierarchy>',
    },
    {
      label: "stripDumpTrailer returns null when the dump failed",
      actual: stripDumpTrailer("ERROR: could not get idle state."),
      expected: null,
    },
    {
      label: "parseForeground reads the package and activity from mCurrentFocus",
      actual: parseForeground(CURRENT),
      expected: { packageName: "app.controlplus", activity: "com.webverif.MainActivity" },
    },
    {
      // `mCurrentFocus` is momentarily `null` during a window animation.
      label: "parseForeground falls back to mFocusedApp mid-transition",
      actual: parseForeground(
        "  mCurrentFocus=null\n" +
          "  mFocusedApp=ActivityRecord{fc1e8d6 u0 com.acme.app/.MainActivity t9}",
      ),
      expected: { packageName: "com.acme.app", activity: "com.acme.app.MainActivity" },
    },
    {
      label: "parseForeground answers null when nothing has focus",
      actual: parseForeground("mCurrentFocus=null"),
      expected: null,
    },
    {
      label: "parsePackages strips the package: prefix and sorts",
      actual: parsePackages("package:com.b\npackage:com.a\n"),
      expected: ["com.a", "com.b"],
    },
    {
      label: "parsePackages handles the -f form that prefixes the apk path",
      actual: parsePackages("package:/data/app/x.apk=com.acme.app"),
      expected: ["com.acme.app"],
    },
    {
      label: "parsePackages ignores non-package lines",
      actual: parsePackages("Warning: something\npackage:com.a"),
      expected: ["com.a"],
    },
    {
      // UiAutomator bounds are in the override size.
      label: "parseScreenSize prefers the override size",
      actual: parseScreenSize("Physical size: 1080x2220\nOverride size: 720x1480"),
      expected: { width: 720, height: 1480 },
    },
    {
      label: "parseScreenSize falls back to the physical size",
      actual: parseScreenSize("Physical size: 1080x2220"),
      expected: { width: 1080, height: 2220 },
    },
    {
      label: "parseScreenSize returns null when `wm size` said nothing useful",
      actual: parseScreenSize(""),
      expected: null,
    },
    {
      label: "parseResolvedActivity skips the priority preamble and returns the component",
      actual: parseResolvedActivity(
        "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n" +
          "app.controlplus/com.webverif.SplashActivity",
      ),
      expected: "app.controlplus/com.webverif.SplashActivity",
    },
    {
      label: "parseResolvedActivity returns null when nothing resolved",
      actual: parseResolvedActivity("No activity found"),
      expected: null,
    },
    {
      label: "parseAvds skips a warning line so it never becomes an AVD name",
      actual: parseAvds("INFO    | Storing crashdata\nPixel_3a_API_34"),
      expected: ["Pixel_3a_API_34"],
    },
    {
      label: "isEmulatorSerial recognises the emulator serial shape",
      actual: isEmulatorSerial("emulator-5554"),
      expected: true,
    },
    {
      // `device_shutdown` keys on this: browxai never powers off a real phone.
      label: "isEmulatorSerial rejects a physical device serial",
      actual: isEmulatorSerial("R5CT30XXXXX"),
      expected: false,
    },
    {
      label: "installFailure finds a failure reported on stdout with a zero exit code",
      actual: installFailure("Performing Streamed Install\nFailure [INSTALL_FAILED_OLDER_SDK]"),
      expected: "Failure [INSTALL_FAILED_OLDER_SDK]",
    },
    {
      label: "installFailure returns null on success",
      actual: installFailure("Performing Streamed Install\nSuccess"),
      expected: null,
    },
  ])("parser: $label", ({ actual, expected }) => {
    expect(actual).toEqual(expected);
  });
});
