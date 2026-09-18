// The ios-app action verbs. They build the same `ActionResult` every other engine
// returns, so the tool surface above stays engine-blind — the shape
// `safari-actions.ts` established for a no-Playwright-Page engine.
//
// EVERY VERB RE-RESOLVES. A target is resolved through the `ElementSubstrate`
// immediately before dispatch and the tap point is computed from the element that
// resolution just returned, in the same call. No coordinate is carried across
// calls and no element handle is held (RFC 0008 §3). That is why each verb takes
// the element port rather than a node: there is exactly one re-resolution path on
// this engine and both the verbs and the verify family go through it.
//
// The action envelope's structure / console / network deltas are NOT captured
// here. A native session has no protocol-level taps, and the honest empty slices
// plus a warning are what Safari does for the same reason. `act_and_diff`'s
// appeared/removed sets come from the snapshot substrate's pre and post trees,
// which do work on this engine.

import type { IosNativeHandle, NativePoint } from "../engine/native-types.js";
import type { ActionResult, DispatchedAction, ElementProbe } from "./actionresult-types.js";
import type * as actions from "./actions-types.js";
import type { ElementRefusal, ElementSubstrate, Rect } from "./element-substrate-types.js";
import { elementQueryFor } from "./element-query.js";

const EMPTY_NETWORK = { summary: { total: 0, byType: {}, failed: 0 } };

/** Said on every `fill`, because an agent that registered a secret has no other
 *  way to learn it was not substituted. The android engine says the same thing
 *  for the same reason. */
const FILL_SECRETS_NOTE =
  "Registered secrets do NOT materialise on the ios-app engine: a `<NAME>` alias is typed or set " +
  "literally. Secret substitution lives in the Playwright action core, which a native session " +
  "never reaches.";

const ENVELOPE_NOTE =
  "the ios-app engine drives XCUITest: the action envelope's console and network slices are not " +
  "captured (a native app has no protocol-level tap). Read screen state with `snapshot` after an " +
  "action, or use `act_and_diff`, whose structure delta comes from the hierarchy.";

/** What every verb needs. `elements` is the session's own `IosElementSubstrate`,
 *  so re-resolution is the same code path the verify family uses. */
export interface IosActionDeps {
  readonly handle: IosNativeHandle;
  readonly elements: ElementSubstrate;
}

function descriptorFor(
  type: DispatchedAction["type"],
  target: actions.ActionTarget,
): DispatchedAction {
  if (target.ref) return { type, ref: target.ref };
  if (target.selector) return { type, selector: target.selector };
  return { type };
}

export function iosResult(
  action: DispatchedAction,
  ok: boolean,
  extra: { error?: string; hint?: string; element?: ElementProbe; warnings?: string[] } = {},
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
    warnings: extra.warnings ?? [ENVELOPE_NOTE],
    ...(extra.element ? { element: extra.element } : {}),
    ...(extra.error ? { error: extra.error + (extra.hint ? ` ${extra.hint}` : "") } : {}),
  };
}

/** A refusal for a verb this engine genuinely has no primitive for. Names the
 *  reason, never "unsupported" alone. */
export function iosUnsupported(type: DispatchedAction["type"], why: string): ActionResult {
  return iosResult({ type }, false, {
    error: `\`${type}\` is not supported on the ios-app engine — ${why}`,
  });
}

/** The centre of the element a target resolves to, re-read from a fresh
 *  hierarchy, or the refusal explaining why there is none. A `coords` target
 *  short-circuits: a pixel is not an element and there is nothing to re-resolve. */
export async function pointFor(
  deps: IosActionDeps,
  target: actions.ActionTarget,
): Promise<NativePoint | ElementRefusal> {
  if (target.coords) return target.coords;
  const query = elementQueryFor(target);
  if (!query) {
    return {
      kind: "refusal",
      reason: "unaddressable-target",
      error: "the target names neither a ref, a selector nor coords",
    };
  }
  const resolved = await deps.elements.resolve(query);
  if (resolved.kind === "refusal") return resolved;
  const bounds = await deps.elements.bounds(resolved.el);
  if (bounds.kind === "refusal") return bounds;
  if (!bounds.rect) {
    return {
      kind: "refusal",
      reason: "stale-element",
      error:
        "the element resolved but XCUITest reports a zero-area frame for it, so there is no point to tap",
      hint: "The element is off-screen or collapsed. Scroll it into view, then re-snapshot.",
    };
  }
  return centreOf(bounds.rect);
}

export function centreOf(rect: Rect): NativePoint {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

/** Render an element refusal as the action's own failure envelope, so a caller
 *  sees one shape whether the refusal came from resolution or from dispatch. */
export function refusedAction(descriptor: DispatchedAction, refusal: ElementRefusal): ActionResult {
  return iosResult(descriptor, false, {
    error: `${refusal.reason}: ${refusal.error}`,
    ...(refusal.hint ? { hint: refusal.hint } : {}),
  });
}

export async function iosNavigate(deps: IosActionDeps, url: string): Promise<ActionResult> {
  if (!/^[a-zA-Z][\w+.-]*:/.test(url)) {
    return iosResult({ type: "navigate", url }, false, {
      error:
        "`navigate` on the ios-app engine opens a URL SCHEME (a deep link) — a native screen has " +
        "no address bar. Pass a full scheme, e.g. `myapp://checkout/42`.",
    });
  }
  await deps.handle.driver.openUrl(url);
  return {
    ...iosResult({ type: "navigate", url }, true),
    navigation: { changed: true, from: "", to: url, kind: "full_load" },
  };
}

export async function iosClick(
  deps: IosActionDeps,
  target: actions.ActionTarget,
): Promise<ActionResult> {
  const descriptor = descriptorFor("click", target);
  const point = await pointFor(deps, target);
  if ("kind" in point) return refusedAction(descriptor, point);
  await deps.handle.driver.tap(point);
  return iosResult(descriptor, true, {
    element: { ref: target.ref, stillAttached: true },
  });
}

/** Element-scoped set-value when the element carries an accessibility identifier,
 *  a tap-then-type otherwise.
 *
 *  The split is a SECRETS decision, not a convenience one (RFC 0008 §6). The
 *  set-value path hands the string straight to XCUITest and no keyboard is
 *  involved. The typed path goes through the on-screen keyboard, and the iOS
 *  keyboard draws a character-preview bubble above each pressed key — which a
 *  screen recording catches even for a secure field. When it takes the typed path
 *  it says so in the result. */
export async function iosFill(
  deps: IosActionDeps,
  target: actions.ActionTarget,
  value: string,
): Promise<ActionResult> {
  const descriptor: DispatchedAction = { ...descriptorFor("fill", target), value };
  const query = elementQueryFor(target);
  if (query) {
    const resolved = await deps.elements.resolve(query);
    if (resolved.kind === "refusal") return refusedAction(descriptor, resolved);
    const read = await deps.elements.probe(resolved.el, { attribute: "accessibilityIdentifier" });
    if (read.kind === "refusal") return refusedAction(descriptor, read);
    const identifier = read.attribute;
    if (identifier) {
      const elementId = await deps.handle.driver.findByIdentifier(identifier);
      if (elementId) {
        await deps.handle.driver.setValue(elementId, value);
        return iosResult(descriptor, true, {
          element: { ref: target.ref, stillAttached: true, value },
          warnings: [ENVELOPE_NOTE, FILL_SECRETS_NOTE],
        });
      }
    }
  }
  const point = await pointFor(deps, target);
  if ("kind" in point) return refusedAction(descriptor, point);
  await deps.handle.driver.tap(point);
  await deps.handle.driver.typeText(value);
  return iosResult(descriptor, true, {
    element: { ref: target.ref, stillAttached: true, value },
    warnings: [
      ENVELOPE_NOTE,
      FILL_SECRETS_NOTE,
      "this element carries no accessibility identifier, so the value was TYPED through the " +
        "on-screen keyboard rather than set on the element. The iOS keyboard draws a character " +
        "preview above each pressed key, which a screen recording captures even for a secure " +
        "field. Add a `testID` in the app to get the element-scoped set-value path.",
    ],
  });
}

/** Hardware and software buttons an iOS simulator actually has. `back` is absent
 *  on purpose: iOS has no back key, and mapping it to a swipe would make an
 *  edge-swipe gesture look like a hardware button press. */
const IOS_BUTTONS: Readonly<Record<string, string>> = {
  home: "home",
  lock: "lock",
  power: "lock",
  volumeup: "volumeUp",
  volumedown: "volumeDown",
};

export async function iosPress(
  deps: IosActionDeps,
  key: string,
  target?: actions.ActionTarget,
): Promise<ActionResult> {
  const descriptor: DispatchedAction = {
    ...(target ? descriptorFor("press", target) : { type: "press" }),
    value: key,
  };
  const button = IOS_BUTTONS[key.toLowerCase()];
  if (button) {
    await deps.handle.driver.pressButton(button);
    return iosResult(descriptor, true);
  }
  if (/^(back|browserback)$/i.test(key)) {
    return iosResult(descriptor, false, {
      error:
        'iOS has no hardware back key — `press({key:"back"})` is an Android idiom. Tap the ' +
        "navigation bar's back button (it is in the snapshot), or use `gesture_swipe` for the " +
        "edge-swipe gesture.",
    });
  }
  if (target) {
    const point = await pointFor(deps, target);
    if ("kind" in point) return refusedAction(descriptor, point);
    await deps.handle.driver.tap(point);
  }
  // Everything else is keyboard input. `Enter` / `Return` is a newline, which is
  // what the software return key sends.
  await deps.handle.driver.typeText(/^(enter|return)$/i.test(key) ? "\n" : key);
  return iosResult(descriptor, true);
}
