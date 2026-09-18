// NativeTargetSubstrate — the structural identity of a native session's target.
//
// RFC 0009 named this port for the TARGET rather than the page precisely so a
// native session could implement it: there is no document, no address bar and no
// title. What there is, on Android, is the window that currently has focus, and
// its package plus activity IS the screen's identity.
//
// `url()` returns `app://<package>/<activity>`, which RFC 0008 §1.5 and §6 both
// rely on: it is the string `SecretRegistry.materialize` scopes against, and the
// existing check is a case-insensitive substring containment, so a secret
// registered with `scope: "com.acme.app"` refuses to materialise into a different
// app's session with no change to the matching logic.
//
// Dependency direction (architecture doctrine §1): tool handler → TargetSubstrate
// (the port in `target-substrate-types.ts`) → this implementation → adb.

import type { TargetSubstrate } from "./target-substrate-types.js";

/** The two device reads this substrate needs, injected so the unit tests drive
 *  the real formatting against a faked device. */
export interface NativeTargetIO {
  foreground(): Promise<{ packageName: string; activity: string } | null>;
}

/** The scheme every native target URL carries. Greppable, and the thing the
 *  secret-scope tests assert on instead of a prose description. */
export const NATIVE_URL_SCHEME = "app://";

/** `app://<package>/<activity>` from a foreground reading. Pure, so the format
 *  the secret scope depends on is testable without a device. */
export function nativeTargetUrl(
  foreground: { packageName: string; activity: string } | null,
): string {
  if (!foreground) return `${NATIVE_URL_SCHEME}unknown`;
  const activity = foreground.activity.startsWith(`${foreground.packageName}.`)
    ? foreground.activity.slice(foreground.packageName.length + 1)
    : foreground.activity;
  return `${NATIVE_URL_SCHEME}${foreground.packageName}/${activity}`;
}

export class NativeTargetSubstrate implements TargetSubstrate {
  readonly engine: string;

  constructor(
    private readonly io: NativeTargetIO,
    engine = "android-app",
  ) {
    this.engine = engine;
  }

  async url(): Promise<string> {
    return nativeTargetUrl(await this.io.foreground());
  }

  /** The screen's name. The activity's short class name is what an Android
   *  developer calls the screen, and it is the only per-screen label the platform
   *  offers without reaching into the app. A React Native app renders every
   *  screen inside ONE activity, so this is stable across in-app navigation — a
   *  real limit, and the snapshot tree is where per-screen identity actually
   *  lives on RN. */
  async title(): Promise<string> {
    const fg = await this.io.foreground();
    if (!fg) return "";
    return fg.activity.split(".").pop() ?? fg.activity;
  }
}
