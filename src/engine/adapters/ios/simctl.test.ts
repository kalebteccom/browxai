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
      {
        udid: "CDAC2948-4927-4501-B01C-9B8870B6216E",
        isAvailable: true,
        state: "Shutdown",
        name: "Apple TV 4K",
      },
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
      screenshotArgs("U", "/tmp/a b/s.png"),
    ]) {
      expect(argv.every((a) => typeof a === "string")).toBe(true);
      expect(argv[0]).toBe("simctl");
    }
  });
});

describe("pure parsers and device selection", () => {
  const devices = parseDevices(LIST_JSON);
  const shutdown: NativeDeviceInfo[] = [
    { id: "a", name: "old", state: "shutdown", runtime: "iOS 9.3", platform: "ios" },
    { id: "b", name: "new", state: "shutdown", runtime: "iOS 26.5", platform: "ios" },
  ];

  it.each([
    {
      label: "runtimeLabel reads the runtime identifier into an OS and a version",
      actual: runtimeLabel("com.apple.CoreSimulator.SimRuntime.iOS-26-5"),
      expected: "iOS 26.5",
    },
    {
      label: "runtimeLabel returns an unrecognised identifier verbatim instead of mangling it",
      actual: runtimeLabel("something-else-entirely"),
      expected: "something-else-entirely",
    },
    {
      // The exact list excludes the unavailable-runtime row and the tvOS device.
      // simctl keeps rows for runtimes that are no longer installed, and offering
      // one as a boot target fails opaquely tens of seconds later.
      label:
        "parseDevices reports the available iOS devices with state and runtime, drops the rest",
      actual: devices.map((d) => `${d.name} ${d.runtime} ${d.state} ${d.platform}`),
      expected: ["iPhone 15 Pro iOS 17.2 shutdown ios", "iPhone 17 iOS 26.5 booted ios"],
    },
    {
      label: "parseDevices returns an empty list rather than throwing on unparseable output",
      actual: parseDevices("not json at all"),
      expected: [],
    },
    {
      label: "selectDevice matches a requested udid",
      actual: selectDevice(devices, "5B31F7E3-0372-431C-89F1-7CE1A3DC28FD").name,
      expected: "iPhone 15 Pro",
    },
    {
      label: "selectDevice matches an exact device name",
      actual: selectDevice(devices, "iPhone 17").id,
      expected: "EFFE589F-6328-47F3-B0BE-44075216B709",
    },
    {
      label: "selectDevice prefers a booted device when none was requested",
      actual: selectDevice(devices).name,
      expected: "iPhone 17",
    },
    {
      // A string compare puts "iOS 9.3" above "iOS 26.5".
      label: "selectDevice picks the newest runtime numerically, not lexically",
      actual: selectDevice(shutdown).name,
      expected: "new",
    },
    {
      label: "parseInstalledApps reads bundle ids and display names out of the OpenStep plist",
      actual: parseInstalledApps(LISTAPPS),
      expected: [
        { bundleId: "com.apple.Bridge", name: "Watch" },
        { bundleId: "com.acme.checkout", name: "Acme Checkout" },
      ],
    },
    {
      // Fewer rows, never invented ones. The caller treats empty as "could not
      // enumerate" rather than "no apps installed".
      label: "parseInstalledApps yields no rows for a shape it does not recognise",
      actual: parseInstalledApps("{}"),
      expected: [],
    },
    {
      label: "parseLaunchPid reads the pid out of simctl launch's one-line report",
      actual: parseLaunchPid("com.acme.checkout: 51234\n"),
      expected: 51234,
    },
    {
      label: "parseLaunchPid reports undefined rather than a wrong number when the format differs",
      actual: parseLaunchPid("launched"),
      expected: undefined,
    },
  ])("$label", ({ actual, expected }) => {
    expect(actual).toEqual(expected);
  });

  it.each([
    {
      // Silently falling back would run a QA session against the wrong OS and
      // report it as the requested one.
      label: "refuses a requested device that does not exist instead of picking another",
      select: () => selectDevice(devices, "iPhone 4"),
      message: /no iOS simulator matches "iPhone 4"/,
    },
    {
      label: "refuses when there is nothing to pick",
      select: () => selectDevice([]),
    },
  ] as Array<{ label: string; select: () => unknown; message?: RegExp }>)(
    "selectDevice $label",
    ({ select, message }) => {
      expect(select).toThrow(NoSimulatorError);
      if (message) expect(select).toThrow(message);
    },
  );
});
