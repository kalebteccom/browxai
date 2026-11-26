import { describe, expect, it } from "vitest";
import { listDevicesArgs, parsePhysicalDevices, versionArgs, withJsonOutput } from "./devicectl.js";
import {
  DEVICECTL_LIST,
  DEVICE_NAMES,
  IPAD_ID,
  OTHER_PHONE_ID,
  PHONE_ID,
  PHONE_UDID,
  WATCH_ID,
} from "./__fixtures__/devicectl-devices.js";

describe("devicectl argv", () => {
  it("builds `devicectl list devices` with the output flag as separate elements", () => {
    expect(listDevicesArgs()).toEqual(["devicectl", "list", "devices"]);
    expect(withJsonOutput(listDevicesArgs(), "/tmp/x y/out.json")).toEqual([
      "devicectl",
      "list",
      "devices",
      "--json-output",
      "/tmp/x y/out.json",
    ]);
  });

  it("builds the version probe", () => {
    expect(versionArgs()).toEqual(["devicectl", "--version"]);
  });
});

describe("parsePhysicalDevices", () => {
  const devices = parsePhysicalDevices(DEVICECTL_LIST);

  it("keeps iPhones and iPads with an identifier, and drops the watch and the row with none", () => {
    expect(devices.map((d) => d.identifier)).toEqual([PHONE_ID, OTHER_PHONE_ID, IPAD_ID]);
    expect(devices.map((d) => d.identifier)).not.toContain(WATCH_ID);
  });

  it("reads the fields the allowlist, device_list and doctor use", () => {
    expect(devices[0]).toEqual({
      identifier: PHONE_ID,
      udid: PHONE_UDID,
      model: "iPhone 17e",
      productType: "iPhone18,5",
      osVersion: "27.2",
      pairingState: "paired",
      tunnelState: "connected",
      transport: "localNetwork",
      developerMode: "enabled",
      ddiServicesAvailable: true,
    });
  });

  it("drops the device name", () => {
    const text = JSON.stringify(devices);
    for (const name of DEVICE_NAMES) expect(text).not.toContain(name);
    for (const d of devices) expect(Object.keys(d)).not.toContain("name");
  });

  it("falls back to the product type, then `unknown`, for the model", () => {
    const one = (hw: Record<string, unknown>): unknown => ({
      result: {
        devices: [
          {
            identifier: "id-1",
            hardwareProperties: { platform: "iOS", deviceType: "iPhone", ...hw },
          },
        ],
      },
    });
    expect(parsePhysicalDevices(one({ productType: "iPhone18,5" }))[0]?.model).toBe("iPhone18,5");
    const bare = parsePhysicalDevices(one({}))[0];
    expect(bare).toMatchObject({
      model: "unknown",
      pairingState: "unknown",
      tunnelState: "unknown",
      transport: "unknown",
      developerMode: "unknown",
    });
    expect(bare).not.toHaveProperty("osVersion");
    expect(bare).not.toHaveProperty("ddiServicesAvailable");
  });

  it("drops a row that says it is not physical", () => {
    const sim = {
      result: {
        devices: [
          {
            identifier: "id-2",
            hardwareProperties: { platform: "iOS", deviceType: "iPhone", reality: "simulated" },
          },
        ],
      },
    };
    expect(parsePhysicalDevices(sim)).toEqual([]);
  });

  it("yields no rows for a shape it does not recognise", () => {
    for (const bad of [
      undefined,
      null,
      "text",
      3,
      [],
      {},
      { result: {} },
      { result: { devices: {} } },
    ]) {
      expect(parsePhysicalDevices(bad)).toEqual([]);
    }
  });
});
