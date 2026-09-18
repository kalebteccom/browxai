// The pure adb layer: argv construction, the device-shell quoting chokepoint,
// and the output parsers. No device, no binary, no clock.

import { describe, it, expect } from "vitest";
import {
  deepLinkArgs,
  dumpHierarchyArgs,
  encodeInputText,
  emulatorKillArgs,
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

  it("neutralises a command separator", () => {
    expect(shellQuote("a; reboot")).toBe("'a; reboot'");
  });

  it("neutralises command substitution", () => {
    expect(shellQuote("$(reboot)")).toBe("'$(reboot)'");
    expect(shellQuote("`reboot`")).toBe("'`reboot`'");
  });

  it("neutralises a pipe and a redirect", () => {
    expect(shellQuote("x | tee /sdcard/leak")).toBe("'x | tee /sdcard/leak'");
    expect(shellQuote("x > /sdcard/leak")).toBe("'x > /sdcard/leak'");
  });

  it("splices an embedded single quote instead of ending the quoting", () => {
    // The one character that can escape single quotes. `it's` must not become
    // `'it'` followed by a bare `s`.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("wraps the empty string rather than emitting nothing", () => {
    // An unwrapped empty value would VANISH from the argv and shift every later
    // word into the wrong position.
    expect(shellQuote("")).toBe("''");
  });
});

describe("encodeInputText", () => {
  it("encodes spaces the way `input text` needs", () => {
    expect(encodeInputText("hello world")).toBe("hello%sworld");
  });
  it("leaves a value with no spaces alone", () => {
    expect(encodeInputText("hello")).toBe("hello");
  });
});

describe("argv construction", () => {
  it("scopes every command to the serial when one is given", () => {
    expect(tapArgs(10, 20, "emulator-5554").slice(0, 2)).toEqual(["-s", "emulator-5554"]);
    expect(dumpHierarchyArgs("emulator-5554").slice(0, 2)).toEqual(["-s", "emulator-5554"]);
  });

  it("omits the serial flag when none is given", () => {
    expect(tapArgs(10, 20)).toEqual(["shell", "input", "tap", "10", "20"]);
  });

  it("uses exec-out for the two binary-safe streams", () => {
    // `shell screencap` corrupts a PNG by translating LF to CRLF on some
    // transports, which surfaces as an unreadable image with no explanation.
    expect(screencapArgs()).toEqual(["exec-out", "screencap", "-p"]);
    expect(dumpHierarchyArgs()).toEqual(["exec-out", "uiautomator", "dump", "/dev/tty"]);
  });

  it("rounds coordinates, because `input` takes integers", () => {
    expect(tapArgs(10.6, 20.4)).toEqual(["shell", "input", "tap", "11", "20"]);
  });

  it("always sends a swipe duration", () => {
    // Duration is what separates a swipe from a drag to the platform's gesture
    // detectors; omitting it lets the driver pick and the result stops matching
    // what was asked for.
    expect(swipeArgs({ x: 1, y: 2 }, { x: 3, y: 4 }, 300)).toEqual([
      "shell",
      "input",
      "swipe",
      "1",
      "2",
      "3",
      "4",
      "300",
    ]);
  });

  it("builds a motionevent per phase", () => {
    expect(motionEventArgs("DOWN", 5, 6)).toEqual([
      "shell",
      "input",
      "motionevent",
      "DOWN",
      "5",
      "6",
    ]);
  });

  it("quotes agent-supplied text and key names", () => {
    expect(inputTextArgs("a; reboot")).toEqual(["shell", "input", "text", "'a;%sreboot'"]);
    expect(keyEventArgs("KEYCODE_BACK")).toEqual(["shell", "input", "keyevent", "'KEYCODE_BACK'"]);
  });

  it("passes a HOST apk path as its own argv entry, unquoted", () => {
    // `adb install` runs on the host side, so the path never reaches a device
    // shell — quoting it would make adb look for a file whose name has quotes.
    expect(installArgs("/tmp/a b.apk", false)).toEqual(["install", "/tmp/a b.apk"]);
    expect(installArgs("/tmp/a.apk", true)).toEqual(["install", "-r", "/tmp/a.apk"]);
  });

  it("force-stops rather than kills", () => {
    // `am kill` only targets background processes and silently no-ops on the
    // foreground app, so `app_terminate` would report a close that never
    // happened.
    expect(forceStopArgs("com.acme.app")).toContain("force-stop");
  });

  it("restricts the package list to third-party by default", () => {
    expect(listPackagesArgs(true)).toEqual(["shell", "pm", "list", "packages", "-3"]);
    expect(listPackagesArgs(false)).toEqual(["shell", "pm", "list", "packages"]);
  });

  it("opens a deep link as a VIEW intent", () => {
    expect(deepLinkArgs("myapp://checkout/42")).toEqual([
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      "'myapp://checkout/42'",
    ]);
  });

  it("always scopes `emu kill` to a serial", () => {
    expect(emulatorKillArgs("emulator-5554")).toEqual(["-s", "emulator-5554", "emu", "kill"]);
  });
});

describe("stripDumpTrailer", () => {
  it("cuts the status line UiAutomator appends after the XML", () => {
    // Android's own message, typo included.
    const raw = '<hierarchy rotation="0"><node /></hierarchy>UI hierchary dumped to: /dev/tty';
    expect(stripDumpTrailer(raw)).toBe('<hierarchy rotation="0"><node /></hierarchy>');
  });

  it("returns null when the dump failed, so a parser never sees an error message", () => {
    expect(stripDumpTrailer("ERROR: could not get idle state.")).toBeNull();
  });

  it("returns null for a truncated document", () => {
    expect(stripDumpTrailer('<hierarchy rotation="0"><node ')).toBeNull();
  });
});

describe("parseForeground", () => {
  const CURRENT =
    "  mCurrentFocus=Window{7f64b6a u0 app.controlplus/com.webverif.MainActivity}\n" +
    "  mFocusedApp=ActivityRecord{fc1e8d6 u0 app.controlplus/com.webverif.MainActivity t9}";

  it("reads the package and activity from mCurrentFocus", () => {
    expect(parseForeground(CURRENT)).toEqual({
      packageName: "app.controlplus",
      activity: "com.webverif.MainActivity",
    });
  });

  it("falls back to mFocusedApp mid-transition", () => {
    // `mCurrentFocus` is momentarily `null` during a window animation. Reporting
    // "no app is foreground" then would be wrong rather than merely late.
    const transitioning =
      "  mCurrentFocus=null\n" +
      "  mFocusedApp=ActivityRecord{fc1e8d6 u0 com.acme.app/.MainActivity t9}";
    expect(parseForeground(transitioning)).toEqual({
      packageName: "com.acme.app",
      activity: "com.acme.app.MainActivity",
    });
  });

  it("expands a component-relative activity to a full component name", () => {
    const relative = "mCurrentFocus=Window{a u0 com.acme.app/.MainActivity}";
    expect(parseForeground(relative)?.activity).toBe("com.acme.app.MainActivity");
  });

  it("answers null when nothing has focus", () => {
    expect(parseForeground("mCurrentFocus=null")).toBeNull();
  });
});

describe("parsePackages", () => {
  it("strips the package: prefix and sorts", () => {
    expect(parsePackages("package:com.b\npackage:com.a\n")).toEqual(["com.a", "com.b"]);
  });

  it("handles the -f form that prefixes the apk path", () => {
    expect(parsePackages("package:/data/app/x.apk=com.acme.app")).toEqual(["com.acme.app"]);
  });

  it("ignores non-package lines", () => {
    expect(parsePackages("Warning: something\npackage:com.a")).toEqual(["com.a"]);
  });
});

describe("parseScreenSize", () => {
  it("prefers the override size, which is what the window manager lays out to", () => {
    // UiAutomator bounds are expressed in the override size, so reading the
    // physical one would put every computed tap point in the wrong place on a
    // device with a density override.
    const out = "Physical size: 1080x2220\nOverride size: 720x1480";
    expect(parseScreenSize(out)).toEqual({ width: 720, height: 1480 });
  });

  it("falls back to the physical size", () => {
    expect(parseScreenSize("Physical size: 1080x2220")).toEqual({ width: 1080, height: 2220 });
  });

  it("returns null when `wm size` said nothing useful", () => {
    expect(parseScreenSize("")).toBeNull();
  });
});

describe("parseResolvedActivity", () => {
  it("skips the priority preamble and returns the component", () => {
    const out =
      "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n" +
      "app.controlplus/com.webverif.SplashActivity";
    expect(parseResolvedActivity(out)).toBe("app.controlplus/com.webverif.SplashActivity");
  });

  it("returns null when nothing resolved", () => {
    expect(parseResolvedActivity("No activity found")).toBeNull();
  });
});

describe("parseAvds", () => {
  it("returns the bare names", () => {
    expect(parseAvds("Pixel_3a_API_34\nPixel_XL_API_31\n")).toEqual([
      "Pixel_3a_API_34",
      "Pixel_XL_API_31",
    ]);
  });

  it("skips a warning line so it never becomes a bootable AVD name", () => {
    const out = "INFO    | Storing crashdata\nPixel_3a_API_34";
    expect(parseAvds(out)).toEqual(["Pixel_3a_API_34"]);
  });
});

describe("isEmulatorSerial", () => {
  it("recognises the emulator serial shape", () => {
    expect(isEmulatorSerial("emulator-5554")).toBe(true);
  });
  it("rejects a physical device serial", () => {
    // `device_shutdown` keys on this: browxai never powers off a real phone.
    expect(isEmulatorSerial("R5CT30XXXXX")).toBe(false);
  });
});

describe("installFailure", () => {
  it("finds a failure adb reported on stdout with a zero exit code", () => {
    expect(installFailure("Performing Streamed Install\nFailure [INSTALL_FAILED_OLDER_SDK]")).toBe(
      "Failure [INSTALL_FAILED_OLDER_SDK]",
    );
  });

  it("returns null on success", () => {
    expect(installFailure("Performing Streamed Install\nSuccess")).toBeNull();
  });
});
