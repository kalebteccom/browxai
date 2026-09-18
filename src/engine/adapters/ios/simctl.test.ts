// Unit tests for the PURE half of the simctl plumbing — argv construction and
// output parsing. No Xcode, no simulator: the IO half is covered by the
// simulator-gated keystone.
//
// The fixtures are VERBATIM captures from `xcrun simctl` on Xcode 26.5 (trimmed
// to the fields the parsers read), not invented shapes. A parser tested against
// a shape the tool never emits proves nothing, and `listapps` is the case that
// matters: it advertises `-j` and emits an OpenStep property list either way.

import { describe, it, expect } from "vitest";
import {
  bootArgs,
  bootStatusArgs,
  installArgs,
  launchArgs,
  listDevicesArgs,
  NoSimulatorError,
  openUrlArgs,
  parseDevices,
  parseInstalledApps,
  parseLaunchPid,
  privacyGrantArgs,
  runtimeLabel,
  screenshotArgs,
  selectDevice,
  terminateArgs,
} from "./simctl.js";
import type { NativeDeviceInfo } from "../../native-types.js";

const LIST_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-2": [
      {
        udid: "5B31F7E3-0372-431C-89F1-7CE1A3DC28FD",
        isAvailable: true,
        state: "Shutdown",
        name: "iPhone 15 Pro",
      },
      {
        udid: "DEAD0000-0000-0000-0000-000000000000",
        isAvailable: false,
        state: "Shutdown",
        name: "iPhone 15 (unavailable runtime)",
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      {
        udid: "EFFE589F-6328-47F3-B0BE-44075216B709",
        isAvailable: true,
        state: "Booted",
        name: "iPhone 17",
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.tvOS-16-1": [
      { udid: "CDAC2948-4927-4501-B01C-9B8870B6216E", isAvailable: true, state: "Shutdown", name: "Apple TV 4K" },
    ],
  },
});

/** Verbatim `xcrun simctl listapps <udid>` shape (two blocks, trimmed). */
const LISTAPPS = `{
    "com.apple.Bridge" =     {
        ApplicationType = System;
        CFBundleDisplayName = Watch;
        CFBundleIdentifier = "com.apple.Bridge";
    };
    "com.acme.checkout" =     {
        ApplicationType = User;
        CFBundleDisplayName = "Acme Checkout";
        CFBundleIdentifier = "com.acme.checkout";
    };
}`;

describe("simctl argv construction", () => {
  it("never interpolates a value into a command string", () => {
    // The property that makes shell injection structurally impossible: every
    // caller-supplied value is its OWN argv element. A udid, a bundle id and a
    // deep-link URL all reach `execFile` unparsed.
    const evil = 'com.acme.app"; rm -rf /; echo "';
    expect(launchArgs("UDID", evil)).toEqual(["simctl", "launch", "UDID", evil]);
    expect(openUrlArgs("UDID", "myapp://x?y=1&z=2")).toEqual([
      "simctl",
      "openurl",
      "UDID",
      "myapp://x?y=1&z=2",
    ]);
    for (const argv of [
      listDevicesArgs(),
      bootArgs("U"),
      bootStatusArgs("U"),
      installArgs("U", "/tmp/a b/My.app"),
      terminateArgs("U", "com.x"),
      privacyGrantArgs("U", "camera", "com.x"),
      screenshotArgs("U", "/tmp/a b/s.png"),
    ]) {
      expect(argv.every((a) => typeof a === "string")).toBe(true);
      expect(argv[0]).toBe("simctl");
    }
  });

  it("blocks on bootstatus rather than returning as soon as boot is accepted", () => {
    expect(bootStatusArgs("U")).toEqual(["simctl", "bootstatus", "U", "-b"]);
  });
});

describe("runtimeLabel", () => {
  it("reads the runtime identifier into an OS and a version", () => {
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-26-5")).toBe("iOS 26.5");
    expect(runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-17-2")).toBe("iOS 17.2");
  });

  it("returns an unrecognised identifier verbatim instead of mangling it", () => {
    expect(runtimeLabel("something-else-entirely")).toBe("something-else-entirely");
  });
});

describe("parseDevices", () => {
  const devices = parseDevices(LIST_JSON);

  it("reports the available iOS devices with their state and runtime", () => {
    expect(devices.map((d) => `${d.name} ${d.runtime} ${d.state}`)).toEqual([
      "iPhone 15 Pro iOS 17.2 shutdown",
      "iPhone 17 iOS 26.5 booted",
    ]);
    expect(devices.every((d) => d.platform === "ios")).toBe(true);
  });

  it("drops unavailable rows and non-iOS runtimes", () => {
    // simctl keeps rows for runtimes that are no longer installed. Offering one
    // as a boot target fails opaquely tens of seconds later.
    expect(devices.find((d) => d.id.startsWith("DEAD"))).toBeUndefined();
    expect(devices.find((d) => d.name.includes("Apple TV"))).toBeUndefined();
  });

  it("returns an empty list rather than throwing on unparseable output", () => {
    expect(parseDevices("not json at all")).toEqual([]);
  });
});

describe("selectDevice", () => {
  const devices = parseDevices(LIST_JSON);

  it("matches a requested udid or an exact device name", () => {
    expect(selectDevice(devices, "5B31F7E3-0372-431C-89F1-7CE1A3DC28FD").name).toBe("iPhone 15 Pro");
    expect(selectDevice(devices, "iPhone 17").id).toBe("EFFE589F-6328-47F3-B0BE-44075216B709");
  });

  it("refuses a requested device that does not exist instead of picking another", () => {
    // Silently falling back would run a QA session against the wrong OS and
    // report it as the requested one.
    expect(() => selectDevice(devices, "iPhone 4")).toThrow(NoSimulatorError);
    expect(() => selectDevice(devices, "iPhone 4")).toThrow(/no iOS simulator matches "iPhone 4"/);
  });

  it("prefers a booted device when none was requested", () => {
    expect(selectDevice(devices).name).toBe("iPhone 17");
  });

  it("picks the newest runtime numerically, not lexically", () => {
    const shutdown: NativeDeviceInfo[] = [
      { id: "a", name: "old", state: "shutdown", runtime: "iOS 9.3", platform: "ios" },
      { id: "b", name: "new", state: "shutdown", runtime: "iOS 26.5", platform: "ios" },
    ];
    // A string compare puts "iOS 9.3" above "iOS 26.5".
    expect(selectDevice(shutdown).name).toBe("new");
  });

  it("refuses when there is nothing to pick", () => {
    expect(() => selectDevice([])).toThrow(NoSimulatorError);
  });
});

describe("parseInstalledApps", () => {
  it("reads bundle ids and display names out of the OpenStep plist simctl emits", () => {
    expect(parseInstalledApps(LISTAPPS)).toEqual([
      { bundleId: "com.apple.Bridge", name: "Watch" },
      { bundleId: "com.acme.checkout", name: "Acme Checkout" },
    ]);
  });

  it("yields no rows for a shape it does not recognise", () => {
    // Fewer rows, never invented ones. The caller treats empty as "could not
    // enumerate" rather than "no apps installed".
    expect(parseInstalledApps("{}")).toEqual([]);
  });
});

describe("parseLaunchPid", () => {
  it("reads the pid out of simctl launch's one-line report", () => {
    expect(parseLaunchPid("com.acme.checkout: 51234\n")).toBe(51234);
  });

  it("reports undefined rather than a wrong number when the format differs", () => {
    expect(parseLaunchPid("launched")).toBeUndefined();
  });
});
