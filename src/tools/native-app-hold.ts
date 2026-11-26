// The tool-side half of RFC 0014 G3: before `app_launch` or `app_install` on a
// session that carries a `NativeAppGuard` (an `ios-app` session on a real
// phone), ask the guard, and when it says a person must approve, ask through the
// `native_device_app` confirm hook. An approval is recorded on the guard for
// that one call, and `release` drops it when that call failed before spending
// it, so no approval outlives the call a person approved. The lifecycle runs
// the same check, so a caller that skips this is refused there.
//
// A session with no guard (a simulator, an emulator) passes through untouched.

import { confirmNativeDeviceApp } from "../policy/confirm.js";
import type { NativeAppVerb, NativeSessionHandle } from "../engine/native-types.js";
import { jsonResult, type TextResponse } from "./json-result.js";
import type { SessionEntry } from "../session/registry.js";
import type { SessionHost } from "./host.js";

const HINT =
  "A person approves each launch or install of this app on the phone, on the human channel. " +
  "`approve_actions` cannot grant `native_device_app`. To let the agent reach the app without " +
  "asking, the operator lists its bundle id in BROWX_IOS_DEVICE_APPS.";

/** Either the refusal to return, or `release`, which the caller runs in a
 *  `finally` around the lifecycle call. */
export type NativeAppHold = { refused: TextResponse } | { release: () => void };

const NOTHING_HELD: NativeAppHold = { release: () => undefined };

export async function holdNativeApp(
  host: Pick<SessionHost, "confirmCtxFor">,
  e: SessionEntry,
  handle: NativeSessionHandle,
  verb: NativeAppVerb,
  subject: string,
): Promise<NativeAppHold> {
  const guard = handle.appGuard;
  if (!guard) return NOTHING_HELD;
  const decision = await guard.check(verb, subject);
  if (decision.kind === "allow") return NOTHING_HELD;
  if (decision.kind === "refuse") {
    return { refused: jsonResult({ ok: false, error: decision.error }) };
  }
  const tool = `app_${verb}`;
  const answer = await confirmNativeDeviceApp(
    tool,
    decision.appId,
    decision.why,
    host.confirmCtxFor(e),
  );
  if (!answer.ok) {
    return {
      refused: jsonResult({
        ok: false,
        action: { type: tool },
        error: `policy: ${answer.reason}`,
        hint: HINT,
      }),
    };
  }
  guard.admitOnce(verb, decision.appId);
  return { release: () => guard.forget(verb, decision.appId) };
}
