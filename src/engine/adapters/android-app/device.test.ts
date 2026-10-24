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

const SERIAL = "emulator-5554";

describe("dumpHierarchy", () => {
  it("returns the XML with UiAutomator's trailer stripped", async () => {
    const io = fakeIO({ uiautomator: DUMP });
    const xml = await new AndroidDevice(SERIAL, io).dumpHierarchy();
    expect(xml.endsWith("</hierarchy>")).toBe(true);
    expect(xml).not.toContain("hierchary dumped");
  });
});

describe("screenshot", () => {
  it("returns the PNG bytes", async () => {
    const io = fakeIO({ screencap: PNG_1X1 });
    const png = await new AndroidDevice(SERIAL, io).screenshot();
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe("input", () => {
  it("dispatches a tap through the OS input pipeline", async () => {
    const io = fakeIO();
    await new AndroidDevice(SERIAL, io).tap(100, 200);
    expect(io.calls[0]).toEqual(["-s", SERIAL, "shell", "input", "tap", "100", "200"]);
  });

  it("dispatches a raw touch phase on API 30 and later", async () => {
    const io = fakeIO({ "ro.build.version.sdk": "34" });
    await new AndroidDevice(SERIAL, io).motionEvent("MOVE", 7, 8);
    expect(io.calls.at(-1)).toContain("motionevent");
  });

  it("sends a newline as an ENTER keyevent", async () => {
    // `input text` has no newline encoding. Dropping one silently would make a
    // multi-line fill land wrong with no signal.
    const io = fakeIO();
    await new AndroidDevice(SERIAL, io).typeText("one\ntwo");
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
    const activity = await new AndroidDevice(SERIAL, io).launchApp("com.acme.app");
    expect(activity).toBe("com.acme.app/.MainActivity");
    expect(io.calls.at(-1)!.join(" ")).toContain("am start -n");
  });

  it("accepts a successful clear", async () => {
    const io = fakeIO({ "pm clear": "Success" });
    await expect(new AndroidDevice(SERIAL, io).clearApp("com.acme.app")).resolves.toBeUndefined();
  });
});

describe("reads", () => {
  it("reports API level 0 for an unreadable property", async () => {
    // `sdkLevel` gates a capability check, and a device that will not answer is
    // a device that does not have the capability.
    const io = fakeIO({ "ro.build.version.sdk": "not-a-number" });
    await expect(new AndroidDevice(SERIAL, io).sdkLevel()).resolves.toBe(0);
  });
});

describe("named failures", () => {
  it.each([
    {
      // THE REAL FAILURE MODE. A React Native splash screen with an indeterminate
      // spinner keeps the window busy forever, `uiautomator dump` gives up at ~10s
      // and prints this.
      label: "dumpHierarchy names the idle-state failure instead of handing a parser an error",
      answers: { uiautomator: "ERROR: could not get idle state." },
      call: (d: AndroidDevice) => d.dumpHierarchy(),
      error: /native-hierarchy-not-idle/,
    },
    {
      label: "dumpHierarchy names the one-owner collision when the dump comes back empty",
      answers: {},
      call: (d: AndroidDevice) => d.dumpHierarchy(),
      error: /native-hierarchy-unavailable/,
    },
    {
      // The classic `shell` vs `exec-out` CRLF corruption.
      label: "screenshot refuses bytes that are not a PNG",
      answers: { screencap: Buffer.from("not a png at all") },
      call: (d: AndroidDevice) => d.screenshot(),
      error: /native-screenshot-failed/,
    },
    {
      // `input motionevent` arrived in API 30; below it the gesture silently does nothing.
      label: "motionEvent refuses a raw touch phase below API 30, by name",
      answers: { "ro.build.version.sdk": "29" },
      call: (d: AndroidDevice) => d.motionEvent("DOWN", 1, 2),
      error: /native-touch-unsupported/,
    },
    {
      label: "launchApp names a missing package",
      answers: { "resolve-activity": "No activity found" },
      call: (d: AndroidDevice) => d.launchApp("com.absent"),
      error: /native-app-not-installed/,
    },
    {
      label: "install reads a failure off stdout, where adb puts it with a zero exit",
      answers: { install: "Failure [INSTALL_FAILED_OLDER_SDK]" },
      call: (d: AndroidDevice) => d.install("/tmp/a.apk", false),
      error: /native-install-failed/,
    },
    {
      label: "clearApp treats a clear without `Success` as a failure",
      answers: { "pm clear": "Failed" },
      call: (d: AndroidDevice) => d.clearApp("com.acme.app"),
      error: /native-app-clear-failed/,
    },
    {
      label: "openDeepLink surfaces a deep link that no activity handles",
      answers: { "action.VIEW": "Error: Activity not started, unable to resolve Intent" },
      call: (d: AndroidDevice) => d.openDeepLink("myapp://nope"),
      error: /native-deep-link-failed/,
    },
    {
      label: "screenSize names an unreadable screen size",
      answers: { "wm size": "" },
      call: (d: AndroidDevice) => d.screenSize(),
      error: NativeDeviceError,
    },
  ])("$label", async ({ answers, call, error }) => {
    await expect(call(new AndroidDevice(SERIAL, fakeIO(answers)))).rejects.toThrow(error);
  });
});
