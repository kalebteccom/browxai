// Safari action helpers. Safari has no Playwright Page, so the Playwright action
// core (actions.ts → runInActionWindow → ctx.page) cannot run — `ctxFor(e)` throws
// at context construction. The curated subset that works on Safari is routed here
// instead, driving the Safari-native WebDriver Classic client (element find →
// click / clear / sendKeys, navigation) and returning the same `ActionResult`
// shape so the tool surface stays engine-blind.
//
// A ref or a css `selector` resolves to a WebDriver element by CSS: a ref is
// turned into the most stable selector its snapshot locator carries (a
// `[data-testid=…]`-style attribute when present, else the structural css path).
// `coords` and role/name-only refs are not addressable this way and are refused.
// The action envelope's structure / console / network deltas are NOT captured on
// Safari (it has no protocol-level taps) — surfaced as an honest warning, never
// fabricated.

import type { SafariSessionHandle } from "../engine/index.js";
import type { RefRegistry } from "./refs.js";
import type { ActionResult, DispatchedAction, ElementProbe } from "./actionresult.js";
import type { ActionTarget } from "./locator.js";

const EMPTY_NETWORK = { summary: { total: 0, byType: {}, failed: 0 } };
const ENVELOPE_NOTE =
  "Safari is driven over WebDriver: the action envelope's structure / console / network deltas are " +
  "not captured on the Safari engine. Read page state with `snapshot` after an action.";

/** W3C WebDriver key codes for the named keys `press` accepts. A bare single
 *  character is sent as-is; anything else falls back to the literal string. */
const WEBDRIVER_KEYS: Readonly<Record<string, string>> = {
  Enter: "\uE007",
  Tab: "\uE004",
  Escape: "\uE00C",
  Backspace: "\uE003",
  Delete: "\uE017",
  Space: "\uE00D",
  ArrowUp: "\uE013",
  ArrowDown: "\uE015",
  ArrowLeft: "\uE012",
  ArrowRight: "\uE014",
};

function descriptorFor(type: DispatchedAction["type"], target: ActionTarget): DispatchedAction {
  if (target.ref) return { type, ref: target.ref };
  if (target.selector) return { type, selector: target.selector };
  return { type };
}

function result(
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
    warnings: extra.warnings ?? [ENVELOPE_NOTE],
    ...(extra.element ? { element: extra.element } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

/** Resolve an action target to a CSS selector the WebDriver `findElement` can use,
 *  or null when the target is not addressable on Safari (coords, or a ref whose
 *  snapshot locator carries neither a test attribute nor a css path). */
function selectorForTarget(refs: RefRegistry, target: ActionTarget): string | null {
  if (target.selector) return target.selector;
  if (!target.ref) return null;
  const loc = refs.locatorOf(target.ref);
  if (!loc) return null;
  if (loc.testId && loc.testIdAttr)
    return `[${loc.testIdAttr}="${loc.testId.replace(/(["\\])/g, "\\$1")}"]`;
  return loc.cssPath ?? null;
}

function unaddressable(action: DispatchedAction): ActionResult {
  return result(action, false, {
    error:
      "this target is not addressable on the Safari engine — pass a `ref` (from snapshot/find) whose " +
      "element carries a test attribute or css path, or a css `selector`. `coords` are not supported.",
  });
}

async function resolveElement(
  handle: SafariSessionHandle,
  selector: string,
): Promise<string | null> {
  return handle.webDriver.findElement(handle.sessionId, "css selector", selector);
}

export async function safariNavigate(
  handle: SafariSessionHandle,
  url: string,
): Promise<ActionResult> {
  const wd = handle.webDriver;
  const from = await wd.currentUrl(handle.sessionId).catch(() => "");
  await wd.navigate(handle.sessionId, url);
  const to = await wd.currentUrl(handle.sessionId).catch(() => url);
  const changed = from !== to;
  return {
    ok: true,
    action: { type: "navigate", url },
    navigation: { changed, from, to, kind: changed ? "full_load" : null },
    structure: { appeared: [], removed: [], newTabs: [] },
    console: { errors: [], warnings: 0 },
    pageErrors: [],
    network: EMPTY_NETWORK,
    tokensEstimate: 0,
    warnings: [ENVELOPE_NOTE],
  };
}

export async function safariClick(
  handle: SafariSessionHandle,
  refs: RefRegistry,
  target: ActionTarget,
): Promise<ActionResult> {
  const descriptor = descriptorFor("click", target);
  const selector = selectorForTarget(refs, target);
  if (!selector) return unaddressable(descriptor);
  const el = await resolveElement(handle, selector);
  if (!el) return result(descriptor, false, { error: `no element matches "${selector}"` });
  await handle.webDriver.elementClick(handle.sessionId, el);
  return result(descriptor, true, { element: { ref: target.ref, stillAttached: true } });
}

export async function safariFill(
  handle: SafariSessionHandle,
  refs: RefRegistry,
  target: ActionTarget,
  value: string,
): Promise<ActionResult> {
  const descriptor: DispatchedAction = { ...descriptorFor("fill", target), value };
  const selector = selectorForTarget(refs, target);
  if (!selector) return unaddressable(descriptor);
  const el = await resolveElement(handle, selector);
  if (!el) return result(descriptor, false, { error: `no element matches "${selector}"` });
  await handle.webDriver.elementClear(handle.sessionId, el);
  await handle.webDriver.elementValue(handle.sessionId, el, value);
  const landed = await handle.webDriver
    .elementProperty(handle.sessionId, el, "value")
    .catch(() => null);
  return result(descriptor, true, {
    element: { ref: target.ref, stillAttached: true, value: landed ?? value },
  });
}

export async function safariPress(
  handle: SafariSessionHandle,
  refs: RefRegistry,
  target: ActionTarget,
  key: string,
): Promise<ActionResult> {
  const descriptor: DispatchedAction = { ...descriptorFor("press", target), value: key };
  const selector = selectorForTarget(refs, target);
  if (!selector) return unaddressable(descriptor);
  const el = await resolveElement(handle, selector);
  if (!el) return result(descriptor, false, { error: `no element matches "${selector}"` });
  await handle.webDriver.elementValue(handle.sessionId, el, WEBDRIVER_KEYS[key] ?? key);
  return result(descriptor, true, { element: { ref: target.ref, stillAttached: true } });
}
