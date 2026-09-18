// The EmulationSubstrate position for the ios-app engine — three refusals.
//
// The three live-mutator knobs this port owns are geolocation, colour scheme and
// reduced motion. A simulator HAS all three, and none of them is reachable
// through XCUITest: location is `simctl location`, appearance is `simctl ui
// appearance`, and reduced motion is an accessibility setting behind
// `simctl spawn defaults`. Each is a device-lifecycle mutation rather than a
// per-session override, which is the difference this port draws — an override
// applies to one session and reverts with it, while a simulator setting persists
// on the device for every session after it.
//
// So they refuse here and name the command that would do it, instead of quietly
// changing state that outlives the session that asked.
//
// Dependency direction (architecture doctrine §1): tool handler →
// EmulationSubstrate (the port in `emulation-substrate-types.ts`) → this
// implementation. This file never imports back from the `emulation-substrate.js`
// barrel.

import type {
  EmulationRefusal,
  EmulationResult,
  EmulationSubstrate,
} from "./emulation-substrate-types.js";

export class IosEmulationSubstrate implements EmulationSubstrate {
  readonly engine = "ios-app";

  async setGeolocation(): Promise<EmulationResult> {
    return refuse(
      "set_geolocation",
      "`xcrun simctl location <udid> set <lat>,<lon>` sets it on the DEVICE, which outlives this " +
        "session",
    );
  }

  async setColorScheme(): Promise<EmulationResult> {
    return refuse(
      "set_color_scheme",
      "`xcrun simctl ui <udid> appearance light|dark` sets it on the DEVICE, which outlives this " +
        "session",
    );
  }

  async setReducedMotion(): Promise<EmulationResult> {
    return refuse(
      "set_reduced_motion",
      "it is an accessibility setting on the DEVICE, not a per-session override",
    );
  }
}

function refuse(tool: string, how: string): EmulationRefusal {
  return {
    kind: "refusal",
    error:
      `\`${tool}\` is not supported on the ios-app engine — XCUITest has no live override for it, ` +
      `and ${how}.`,
    hint:
      "Set it on the simulator yourself before opening the session. browxai refuses rather than " +
      "mutate device state that survives the session that asked for it.",
  };
}
