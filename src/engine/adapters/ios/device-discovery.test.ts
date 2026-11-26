import { describe, expect, it } from "vitest";
import { listIosDevices } from "./device-discovery.js";
import type { DevicectlRunner } from "./devicectl.js";
import {
  DEVICE_NAMES,
  DEVICE_UDIDS,
  DEVICECTL_LIST,
  OTHER_PHONE_UDID,
  PHONE_ID,
} from "./__fixtures__/devicectl-devices.js";

function fake(answer: unknown = DEVICECTL_LIST): { run: DevicectlRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: DevicectlRunner = async (args) => {
    calls.push([...args]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
}

describe("listIosDevices", () => {
  it("does not run devicectl when the target is the simulator", async () => {
    const { run, calls } = fake();
    expect(await listIosDevices({}, run)).toEqual({ iosDevices: [], iosDevicesNotAllowed: 0 });
    expect(
      await listIosDevices(
        { BROWX_IOS_TARGET: "simulator", BROWX_IOS_DEVICE_ALLOWLIST: PHONE_ID },
        run,
      ),
    ).toEqual({ iosDevices: [], iosDevicesNotAllowed: 0 });
    expect(calls).toEqual([]);
  });

  it("lists allowlisted phones and counts the others", async () => {
    const { run, calls } = fake();
    const env = { BROWX_IOS_TARGET: "device", BROWX_IOS_DEVICE_ALLOWLIST: PHONE_ID };
    const listing = await listIosDevices(env, run);
    expect(calls).toEqual([["devicectl", "list", "devices"]]);
    expect(listing).toEqual({
      iosDevices: [
        {
          id: PHONE_ID,
          model: "iPhone 17e",
          osVersion: "27.2",
          pairingState: "paired",
          tunnelState: "connected",
          transport: "localNetwork",
          developerMode: "enabled",
        },
      ],
      // The other iPhone and the iPad; the watch is not an iOS device.
      iosDevicesNotAllowed: 2,
    });
  });

  it("matches a hardware UDID entry and reports the phone by its CoreDevice identifier", async () => {
    const { run } = fake();
    const env = { BROWX_IOS_TARGET: "device", BROWX_IOS_DEVICE_ALLOWLIST: OTHER_PHONE_UDID };
    const listing = await listIosDevices(env, run);
    expect(listing.iosDevices).toHaveLength(1);
    expect(listing.iosDevices[0]?.id).not.toBe(OTHER_PHONE_UDID);
    expect(listing.iosDevicesNotAllowed).toBe(2);
  });

  it("with an empty allowlist, lists nothing and counts every phone", async () => {
    const { run } = fake();
    expect(await listIosDevices({ BROWX_IOS_TARGET: "device" }, run)).toEqual({
      iosDevices: [],
      iosDevicesNotAllowed: 3,
    });
  });

  it("gives an empty answer when devicectl is absent or fails", async () => {
    const { run } = fake(new Error("devicectl-missing: not found"));
    const env = { BROWX_IOS_TARGET: "device", BROWX_IOS_DEVICE_ALLOWLIST: PHONE_ID };
    expect(await listIosDevices(env, run)).toEqual({ iosDevices: [], iosDevicesNotAllowed: 0 });
  });

  it("rejects a mistyped target without running devicectl", async () => {
    const { run, calls } = fake();
    await expect(listIosDevices({ BROWX_IOS_TARGET: "phone" }, run)).rejects.toThrow(
      /ios-target-invalid/,
    );
    expect(calls).toEqual([]);
  });

  it("never carries a device name or a hardware UDID", async () => {
    const { run } = fake();
    const env = {
      BROWX_IOS_TARGET: "device",
      BROWX_IOS_DEVICE_ALLOWLIST: DEVICE_UDIDS.join(","),
    };
    const text = JSON.stringify(await listIosDevices(env, run));
    for (const name of DEVICE_NAMES) expect(text).not.toContain(name);
    for (const udid of DEVICE_UDIDS) expect(text).not.toContain(udid);
  });
});
