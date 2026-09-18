// Native-handle assertion — the single legal caller of `BrowserSession.native?()`
// from above the substrate seam.
//
// It mirrors `requireCdp` and `requirePage` exactly, and for the same reason. The
// app-lifecycle tools (`app_launch`, `app_reset`, `app_foreground`, …) have no
// browser analogue, so there is no capability substrate they could route through
// — a substrate exists where two engines answer the same question differently,
// and only a native engine can answer "which app is in the foreground". They are
// engine-specific tools, and this is how the codebase already expresses that: a
// structured refusal naming the engine, produced once, rather than an
// `engine === "android-app"` branch in each handler (which
// `no-engine-literal-branches` forbids) or a bare `native!()` that erases to
// `undefined()` and an opaque `TypeError` on any other engine.
//
// The refusal is REACHED. Every other engine's session omits the member, so a
// `app_launch` call on a chromium session lands here and gets a sentence that
// says what to do instead.

import type { NativeSessionHandle } from "./adapters/android-app/handle.js";

/** A session shape carrying the optional native accessor plus its engine tag.
 *  The full `BrowserSession` satisfies this; the narrow shape keeps this module
 *  from pulling the whole session interface into the engine layer. */
export interface NativeCapable {
  readonly engine: string;
  native?(): NativeSessionHandle;
}

/** The greppable reason a caller matches on instead of the prose. */
export const NATIVE_ENGINE_REQUIRED = "native-engine-required";

/** Return the session's native handle, or throw a structured error naming the
 *  engine. On a native session the member is always present, so this is a single
 *  truthiness check and a direct delegate. */
export function requireNative(session: NativeCapable): NativeSessionHandle {
  if (!session.native) {
    throw new Error(
      `${NATIVE_ENGINE_REQUIRED}: engine "${session.engine}" is not a native engine, and this ` +
        "tool drives a device. Device and app lifecycle have no browser analogue — there is no " +
        "package to launch and no foreground app to report. Open a native session with " +
        '`open_session({browserType:"android-app"})`, which needs the off-by-default ' +
        "`native-device` capability.",
    );
  }
  return session.native();
}
