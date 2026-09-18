// The native action verbs — tap, type, key, scroll, deep-link — and the
// `ActionResult` envelope they return, which is the same envelope every other
// engine returns so the tool surface stays engine-blind.
//
// EVERY VERB RE-RESOLVES. A verb takes a target, asks the element substrate for
// its bounds, and dispatches at the point that read just returned, in the same
// call. There is no stored coordinate anywhere in this module — RFC 0008 §3, and
// the reason the owner's trial rejected the alternative.
//
// SECRETS DO NOT MATERIALISE HERE, AND THAT IS THE SAFE STATE. On web,
// `materialiseValue` substitutes a registered `<NAME>` alias for its real value
// inside `actions.ts`, which is the Playwright adapter's own internals. A native
// session never reaches that code, so a `<NAME>` alias is typed literally rather
// than resolved — the same behaviour the Safari engine has had since it shipped.
// It matters more here, because RFC 0008 §6 names `adb shell input text <secret>`
// as a leak sink: the secret would land in the device's shell history and in
// anything tailing logcat. Since the secret never arrives, the sink does not
// exist on this engine. `fill` says so in its warning rather than leaving an
// agent to discover it from a failed login.

import type { ActionResult, DispatchedAction, ElementProbe } from "./actionresult-types.js";
import type { ActionTarget } from "./actions-types.js";
import type {
  ElementBoundsResult,
  ElementQuery,
  ElementSubstrate,
  Rect,
} from "./element-substrate-types.js";

const EMPTY_NETWORK = { summary: { total: 0, byType: {}, failed: 0 } };

/** The envelope note every native action carries. A native session has no
 *  protocol-level network tap and no console subscription at action granularity,
 *  so the deltas are empty — and saying so is the difference between "no requests
 *  happened" and "we did not look". */
export const NATIVE_ENVELOPE_NOTE =
  "android-app is driven over adb: the action envelope's console and network deltas are not " +
  "captured on this engine. Read the screen with `snapshot` after an action.";

/** The Android key names `press` accepts, mapped onto `KEYCODE_*`. The hardware
 *  keys are the point — `back` and `home` have no web analogue and are how a
 *  native agent navigates. A name already in `KEYCODE_*` form passes through, so
 *  the full platform vocabulary stays reachable without this table listing it. */
export const ANDROID_KEYS: Readonly<Record<string, string>> = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  escape: "KEYCODE_ESCAPE",
  backspace: "KEYCODE_DEL",
  delete: "KEYCODE_FORWARD_DEL",
  space: "KEYCODE_SPACE",
  arrowup: "KEYCODE_DPAD_UP",
  arrowdown: "KEYCODE_DPAD_DOWN",
  arrowleft: "KEYCODE_DPAD_LEFT",
  arrowright: "KEYCODE_DPAD_RIGHT",
  menu: "KEYCODE_MENU",
  search: "KEYCODE_SEARCH",
  volumeup: "KEYCODE_VOLUME_UP",
  volumedown: "KEYCODE_VOLUME_DOWN",
  power: "KEYCODE_POWER",
  appswitch: "KEYCODE_APP_SWITCH",
};

/** Map a browxai key name onto an Android keycode, or null when it is not one.
 *  A single printable character is NOT a keycode — it is text, and `press("a")`
 *  types it, which is what the web engines do too. */
export function androidKeyCode(key: string): string | null {
  const direct = ANDROID_KEYS[key.toLowerCase()];
  if (direct) return direct;
  if (/^KEYCODE_[A-Z0-9_]+$/.test(key)) return key;
  return null;
}

export function descriptorFor(
  type: DispatchedAction["type"],
  target?: ActionTarget,
): DispatchedAction {
  if (target?.ref) return { type, ref: target.ref };
  if (target?.selector) return { type, selector: target.selector };
  return { type };
}

export function nativeResult(
  action: DispatchedAction,
  ok: boolean,
  extra: { error?: string; element?: ElementProbe; warnings?: string[] } = {},
): ActionResult {
  return {
    ok,
    action,
    navigation: { changed: false, from: "", to: "", kind: null },
    structure: { appeared: [], removed: [], newTabs: [] },
    console: { errors: [], warnings: 0 },
    pageErrors: [],
    network: EMPTY_NETWORK,
    tokensEstimate: 0,
    warnings: extra.warnings ?? [NATIVE_ENVELOPE_NOTE],
    ...(extra.element ? { element: extra.element } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

/** A clean refusal for a verb with no native meaning. Keeps the gating in the
 *  adapter rather than as `engine === "android-app"` branches in the handlers. */
export function nativeUnsupportedAction(type: DispatchedAction["type"], why: string): ActionResult {
  return nativeResult({ type }, false, { error: `\`${type}\` ${why}` });
}

/** Turn an `ActionTarget` into the port's `ElementQuery`. `coords` is its own
 *  case and never becomes a query: a coordinate IS the dispatch point, so it
 *  skips resolution entirely. */
export function queryFor(target: ActionTarget): ElementQuery | null {
  if (target.ref) return { kind: "ref", ref: target.ref };
  if (target.selector) return { kind: "selector", selector: target.selector };
  return null;
}

/** The centre of a rect — the point a tap lands on. */
export function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Resolve a target to the point to dispatch at, RIGHT NOW.
 *
 *  A refusal comes back as a refusal, so "the ref matched two elements" and "the
 *  ref matched nothing" both reach the agent as themselves rather than as a tap
 *  that silently went somewhere. */
export async function pointFor(
  elements: ElementSubstrate,
  target: ActionTarget,
): Promise<{ point: { x: number; y: number } } | { error: string }> {
  if (target.coords) return { point: target.coords };
  const query = queryFor(target);
  if (!query) {
    return {
      error:
        "this target is not addressable on the android-app engine — pass a `ref` from " +
        "snapshot/find, a native `selector` (`~testID`, `label=…`, `text=…`, " +
        '`role=button[name="…"]`), or `coords`.',
    };
  }
  const resolved = await elements.resolve(query);
  if (resolved.kind === "refusal")
    return { error: `${resolved.error}. ${resolved.hint ?? ""}`.trim() };
  const box: ElementBoundsResult = await elements.bounds(resolved.el);
  if (box.kind === "refusal") return { error: `${box.error}. ${box.hint ?? ""}`.trim() };
  if (!box.rect || box.rect.width <= 0 || box.rect.height <= 0) {
    return {
      error:
        "the element is in the hierarchy but has no rendered box, so there is nothing to tap. " +
        "It may be off-screen or collapsed — `scroll` it into view first.",
    };
  }
  return { point: centreOf(box.rect) };
}

/** The post-action element probe. Read AFTER the dispatch, from a fresh
 *  hierarchy, so `element.value` reports what actually landed. */
export async function probeAfter(
  elements: ElementSubstrate,
  target: ActionTarget,
): Promise<ElementProbe | undefined> {
  const query = queryFor(target);
  if (!query) return undefined;
  const resolved = await elements.resolve(query);
  if (resolved.kind === "refusal") return undefined;
  const reading = await elements.probe(resolved.el, { visible: true, text: true, value: true });
  if (reading.kind === "refusal") return undefined;
  return {
    ref: target.ref ?? "",
    stillAttached: true,
    ...(reading.value !== undefined && reading.value !== null ? { value: reading.value } : {}),
    ...(reading.text ? { displayText: reading.text } : {}),
  };
}
