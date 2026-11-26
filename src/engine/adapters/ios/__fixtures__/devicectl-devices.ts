// A hand-written `devicectl list devices --json-output` result for unit tests.
// The shape follows devicectl on Xcode 15 and 16. Every identifier, UDID, serial
// and name is made up. Replace it with a masked sample from a Mac with Xcode 26.5
// once one exists (RFC 0014 §17, item 1).

export const PHONE_ID = "11111111-AAAA-4AAA-8AAA-111111111111";
export const PHONE_UDID = "00008000-000A11CE0000001E";
export const OTHER_PHONE_ID = "22222222-BBBB-4BBB-8BBB-222222222222";
export const OTHER_PHONE_UDID = "00008000-000B0B000000002E";
export const IPAD_ID = "33333333-CCCC-4CCC-8CCC-333333333333";
export const WATCH_ID = "44444444-DDDD-4DDD-8DDD-444444444444";

/** The device names in the fixture. No result or doctor row may contain one. */
export const DEVICE_NAMES = ["Ana's iPhone", "Bruno's iPhone", "Studio iPad", "Ana's Watch"];
/** The hardware UDIDs in the fixture. No result or doctor row may contain one. */
export const DEVICE_UDIDS = [
  PHONE_UDID,
  OTHER_PHONE_UDID,
  "00008000-000C0C000000003E",
  "00008000-000D0D000000004E",
  "00008000-000E0E000000005E",
];

function device(o: {
  identifier?: string;
  name: string;
  udid: string;
  platform: string;
  deviceType: string;
  marketingName: string;
  productType: string;
  os: string;
  pairing: string;
  tunnel: string;
  transport: string;
  devMode: string;
  ddi: boolean;
}): Record<string, unknown> {
  return {
    capabilities: [
      { featureIdentifier: "com.apple.coredevice.feature.listapps", name: "List Apps" },
    ],
    connectionProperties: {
      authenticationType: "manualPairing",
      isMobileDeviceOnly: false,
      pairingState: o.pairing,
      potentialHostnames: [`${o.udid}.coredevice.local`],
      transportType: o.transport,
      tunnelState: o.tunnel,
      tunnelTransportProtocol: "tcp",
    },
    deviceProperties: {
      bootedFromSnapshot: true,
      ddiServicesAvailable: o.ddi,
      developerModeStatus: o.devMode,
      hasInternalOSBuild: false,
      name: o.name,
      osBuildUpdate: "24A000",
      osVersionNumber: o.os,
    },
    hardwareProperties: {
      deviceType: o.deviceType,
      ecid: 1234567890,
      hardwareModel: "X00AP",
      marketingName: o.marketingName,
      platform: o.platform,
      productType: o.productType,
      reality: "physical",
      serialNumber: "FAKESERIAL0",
      udid: o.udid,
    },
    ...(o.identifier ? { identifier: o.identifier } : {}),
    visibilityClass: "default",
  };
}

export const DEVICECTL_LIST: unknown = {
  info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
  result: {
    devices: [
      device({
        identifier: PHONE_ID,
        name: "Ana's iPhone",
        udid: PHONE_UDID,
        platform: "iOS",
        deviceType: "iPhone",
        marketingName: "iPhone 17e",
        productType: "iPhone18,5",
        os: "27.2",
        pairing: "paired",
        tunnel: "connected",
        transport: "localNetwork",
        devMode: "enabled",
        ddi: true,
      }),
      device({
        identifier: OTHER_PHONE_ID,
        name: "Bruno's iPhone",
        udid: OTHER_PHONE_UDID,
        platform: "iOS",
        deviceType: "iPhone",
        marketingName: "iPhone 16",
        productType: "iPhone17,3",
        os: "26.1",
        pairing: "paired",
        tunnel: "disconnected",
        transport: "wired",
        devMode: "enabled",
        ddi: false,
      }),
      device({
        identifier: IPAD_ID,
        name: "Studio iPad",
        udid: "00008000-000C0C000000003E",
        platform: "iOS",
        deviceType: "iPad",
        marketingName: "iPad Air",
        productType: "iPad14,8",
        os: "27.1",
        pairing: "unpaired",
        tunnel: "unavailable",
        transport: "wired",
        devMode: "disabled",
        ddi: false,
      }),
      device({
        identifier: WATCH_ID,
        name: "Ana's Watch",
        udid: "00008000-000D0D000000004E",
        platform: "watchOS",
        deviceType: "appleWatch",
        marketingName: "Apple Watch",
        productType: "Watch7,1",
        os: "12.0",
        pairing: "paired",
        tunnel: "disconnected",
        transport: "localNetwork",
        devMode: "enabled",
        ddi: false,
      }),
      // No identifier: dropped.
      device({
        name: "Ana's iPhone",
        udid: "00008000-000E0E000000005E",
        platform: "iOS",
        deviceType: "iPhone",
        marketingName: "iPhone 15",
        productType: "iPhone15,4",
        os: "26.0",
        pairing: "paired",
        tunnel: "disconnected",
        transport: "wired",
        devMode: "enabled",
        ddi: false,
      }),
    ],
  },
};
