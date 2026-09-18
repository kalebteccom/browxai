// `AndroidDevice` against a FAKED transport. The real class runs; only the two
// IO methods are substituted, so every argv asserted here is the argv production
// sends, and every named error is the error production raises.

import { describe, it, expect } from "vitest";
import { AndroidDevice, NativeDeviceError, type AndroidDeviceIO } from "./device.js";

/** A recording fake. `text` answers from a per-prefix table so one device can be
 *  set up for a whole scenario; anything unmatched answers empty, which is what
 *  a real `adb shell` does for a command with no output. */
function fakeIO(
  answers: Record<string, string | Buffer> = {},
): AndroidDeviceIO & { calls: string[][] } {
  const calls: string[][] = [];
  const lookup = (args: readonly string[]): string | Buffer | undefined => {
    const joined = args.join(" ");
    for (const [key, value] of Object.entries(answers)) {
      if (joined.includes(key)) return value;
    }
    return undefined;
  };
  return {
    calls,
    text: async (args) => {
      calls.push([...args]);
      const hit = lookup(args);
      return typeof hit === "string" ? hit : "";
    },
    binary: async (args) => {
      calls.push([...args]);
      const hit = lookup(args);
      return Buffer.isBuffer(hit) ? hit : Buffer.from(typeof hit === "string" ? hit : "");
    },
  };
}

const DUMP =
  "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">" +
  '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ' +
  'package="com.acme.app" content-desc="" bounds="[0,0][100,100]" /></hierarchy>' +
  "UI hierchary dumped to: /dev/tty";

/** A 1x1 RGBA PNG. Enough for the magic-number check the screenshot path makes. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("dumpHierarchy", () => {
  it("returns the XML with UiAutomator's trailer stripped", async () => {
    const io = fakeIO({ uiautomator: DUMP });
    const xml = await new AndroidDevice("emulator-5554", io).dumpHierarchy();
    expect(xml.endsWith("</hierarchy>")).toBe(true);
    expect(xml).not.toContain("hierchary dumped");
  });

  it("scopes the dump to the device's serial", async () => {
    const io = fakeIO({ uiautomator: DUMP });
    await new AndroidDevice("emulator-5554", io).dumpHierarchy();
    expect(io.calls[0]!.slice(0, 2)).toEqual(["-s", "emulator-5554"]);
  });

  it("names the idle-state failure instead of handing a parser an error message", async () => {
    // THE REAL FAILURE MODE. A React Native splash screen with an indeterminate
    // spinner keeps the window busy forever, `uiautomator dump` gives up at ~10s
    // and prints this. Reproduced against a real emulator while building P2.
    const io = fakeIO({ uiautomator: "ERROR: could not get idle state." });
    await expect(new AndroidDevice("emulator-5554", io).dumpHierarchy()).rejects.toThrow(
      /native-hierarchy-not-idle/,
    );
  });

  it("names the one-owner collision when the dump comes back empty", async () => {
    const io = fakeIO({});
    await expect(new AndroidDevice("emulator-5554", io).dumpHierarchy()).rejects.toThrow(
      /native-hierarchy-unavailable/,
    );
  });
});

describe("screenshot", () => {
  it("returns the PNG bytes", async () => {
    const io = fakeIO({ screencap: PNG_1X1 });
    const png = await new AndroidDevice("emulator-5554", io).screenshot();
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("refuses bytes that are not a PNG", async () => {
    // The classic `shell` vs `exec-out` CRLF corruption. A caller that got the
    // mangled bytes would see a broken image with no explanation.
    const io = fakeIO({ screencap: Buffer.from("not a png at all") });
    await expect(new AndroidDevice("emulator-5554", io).screenshot()).rejects.toThrow(
      /native-screenshot-failed/,
    );
  });
});

describe("input", () => {
  it("dispatches a tap through the OS input pipeline", async () => {
    const io = fakeIO();
    await new AndroidDevice("emulator-5554", io).tap(100, 200);
    expect(io.calls[0]).toEqual(["-s", "emulator-5554", "shell", "input", "tap", "100", "200"]);
  });

  it("dispatches a swipe as ONE platform call", async () => {
    // Not three touch events glued together: `input swipe` interpolates in the
    // driver, which is what makes it a real gesture to the app's detectors.
    const io = fakeIO();
    await new AndroidDevice("emulator-5554", io).swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 250);
    expect(io.calls).toHaveLength(1);
    expect(io.calls[0]).toContain("swipe");
  });

  it("refuses a raw touch phase below API 30, by name", async () => {
    // `input motionevent` arrived in API 30. Running it below that produces
    // shell noise about an unknown argument, and the gesture silently does
    // nothing.
    const io = fakeIO({ "ro.build.version.sdk": "29" });
    await expect(new AndroidDevice("emulator-5554", io).motionEvent("DOWN", 1, 2)).rejects.toThrow(
      /native-touch-unsupported/,
    );
  });

  it("dispatches a raw touch phase on API 30 and later", async () => {
    const io = fakeIO({ "ro.build.version.sdk": "34" });
    await new AndroidDevice("emulator-5554", io).motionEvent("MOVE", 7, 8);
    expect(io.calls.at(-1)).toContain("motionevent");
  });

  it("quotes typed text for the device shell", async () => {
    const io = fakeIO();
    await new AndroidDevice("emulator-5554", io).typeText("a; reboot");
    expect(io.calls[0]!.at(-1)).toBe("'a;%sreboot'");
  });

  it("sends a newline as an ENTER keyevent", async () => {
    // `input text` has no newline encoding. Dropping one silently would make a
    // multi-line fill land wrong with no signal.
    const io = fakeIO();
    await new AndroidDevice("emulator-5554", io).typeText("one\ntwo");
    const commands = io.calls.map((c) => c.join(" "));
    expect(commands[0]).toContain("input text 'one'");
    expect(commands[1]).toContain("keyevent 'KEYCODE_ENTER'");
    expect(commands[2]).toContain("input text 'two'");
  });
});

describe("app lifecycle", () => {
  it("resolves the launcher activity before starting it", async () => {
    // A missing package must be reported as a missing package. `monkey -p <pkg>`
    // reports success having done nothing.
    const io = fakeIO({
      "resolve-activity": "priority=0 isDefault=false\ncom.acme.app/.MainActivity",
    });
    const activity = await new AndroidDevice("emulator-5554", io).launchApp("com.acme.app");
    expect(activity).toBe("com.acme.app/.MainActivity");
    expect(io.calls.at(-1)!.join(" ")).toContain("am start -n");
  });

  it("names a missing package", async () => {
    const io = fakeIO({ "resolve-activity": "No activity found" });
    await expect(new AndroidDevice("emulator-5554", io).launchApp("com.absent")).rejects.toThrow(
      /native-app-not-installed/,
    );
  });

  it("reads an install failure off stdout, where adb puts it with a zero exit", async () => {
    const io = fakeIO({ install: "Failure [INSTALL_FAILED_OLDER_SDK]" });
    await expect(
      new AndroidDevice("emulator-5554", io).install("/tmp/a.apk", false),
    ).rejects.toThrow(/native-install-failed/);
  });

  it("treats a clear without `Success` as a failure", async () => {
    const io = fakeIO({ "pm clear": "Failed" });
    await expect(new AndroidDevice("emulator-5554", io).clearApp("com.acme.app")).rejects.toThrow(
      /native-app-clear-failed/,
    );
  });

  it("accepts a successful clear", async () => {
    const io = fakeIO({ "pm clear": "Success" });
    await expect(
      new AndroidDevice("emulator-5554", io).clearApp("com.acme.app"),
    ).resolves.toBeUndefined();
  });

  it("surfaces a deep link that no activity handles", async () => {
    const io = fakeIO({ "action.VIEW": "Error: Activity not started, unable to resolve Intent" });
    await expect(
      new AndroidDevice("emulator-5554", io).openDeepLink("myapp://nope"),
    ).rejects.toThrow(/native-deep-link-failed/);
  });
});

describe("reads", () => {
  it("parses the foreground window", async () => {
    const io = fakeIO({
      "dumpsys window": "mCurrentFocus=Window{a u0 com.acme.app/com.acme.app.MainActivity}",
    });
    await expect(new AndroidDevice("emulator-5554", io).foreground()).resolves.toEqual({
      packageName: "com.acme.app",
      activity: "com.acme.app.MainActivity",
    });
  });

  it("names an unreadable screen size", async () => {
    const io = fakeIO({ "wm size": "" });
    await expect(new AndroidDevice("emulator-5554", io).screenSize()).rejects.toThrow(
      NativeDeviceError,
    );
  });

  it("reports API level 0 for an unreadable property", async () => {
    // `sdkLevel` gates a capability check, and a device that will not answer is
    // a device that does not have the capability.
    const io = fakeIO({ "ro.build.version.sdk": "not-a-number" });
    await expect(new AndroidDevice("emulator-5554", io).sdkLevel()).resolves.toBe(0);
  });
});
