// The ScriptSubstrate position for the ios-app engine — a refusal.
//
// RFC 0008 §2 rules `eval_js` and `poll_eval` out on native by name: a
// release-configuration React Native app has no scriptable context, and reaching
// into a development bridge to manufacture one would be a different trust posture
// than the one the operator agreed to when they enabled `native-device`. The
// engine omits the `script` sub-interface, so the gate refuses both tools
// upstream and this body does not run on the shipped path.
//
// It throws rather than returning a value because `evaluate` returns `unknown`:
// any value it produced would be indistinguishable from a real evaluation result,
// and `undefined` in particular is what a successful `void` expression returns.
//
// Dependency direction (architecture doctrine §1): tool handler → ScriptSubstrate
// (the port in `script-substrate-types.ts`) → this implementation. This file never
// imports back from the `script-substrate.js` barrel.

import type { ScriptSubstrate } from "./script-substrate-types.js";

/** Greppable, and what the keystone asserts on instead of prose. */
export const IOS_SCRIPT_UNREACHABLE = "ios-script-unreachable";

export class IosScriptSubstrate implements ScriptSubstrate {
  readonly engine = "ios-app";

  async evaluate(): Promise<unknown> {
    throw new Error(
      `${IOS_SCRIPT_UNREACHABLE}: the ios-app engine declares no \`script\` sub-interface. A ` +
        "release-configuration native app has no scriptable context, and browxai does not reach " +
        "into a development bridge to make one. `eval_js` and `poll_eval` refuse at the gate; " +
        "reaching this substrate means a tool skipped it.",
    );
  }
}
