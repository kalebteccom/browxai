// The tool-side half of RFC 0014 G3: before `app_launch` or `app_install` on a
// session that carries a `NativeAppGuard` (an `ios-app` session on a real
// phone), ask the guard, and when it says a person must approve, ask through the
// `native_device_app` confirm hook. An approval is recorded on the guard for
// that one call. The lifecycle runs the same check, so a caller that skips this
// is refused there.
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

/** Null when the call may go on, else the refusal to return. */
export async function holdNativeApp(
  host: Pick<SessionHost, "confirmCtxFor">,
  e: SessionEntry,
  handle: NativeSessionHandle,
  verb: NativeAppVerb,
  subject: string,
): Promise<TextResponse | null> {
  const guard = handle.appGuard;
  if (!guard) return null;
  const decision = await guard.check(verb, subject);
  if (decision.kind === "allow") return null;
  if (decision.kind === "refuse") return jsonResult({ ok: false, error: decision.error });
  const tool = `app_${verb}`;
  const answer = await confirmNativeDeviceApp(
    tool,
    decision.appId,
    decision.why,
    host.confirmCtxFor(e),
  );
  if (!answer.ok) {
    return jsonResult({
      ok: false,
      action: { type: tool },
      error: `policy: ${answer.reason}`,
      hint: HINT,
    });
  }
  guard.admitOnce(verb, decision.appId);
  return null;
}
