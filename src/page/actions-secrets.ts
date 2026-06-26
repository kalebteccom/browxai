// Secrets / mask plumbing for the action primitives — dispatch-side
// materialisation of `<NAME>` aliases into registered real strings, post-probe
// masking of any real value that leaked into a probe, and the clean
// ActionResult-shaped failure envelopes a materialisation rejection returns.
// Split out of actions.ts so that file stays focused on the verb primitives;
// behaviour-identical.
//
// This is the second reason-to-change separated from the verbs: the verbs are
// about *dispatching* a Playwright op, this is about keeping registered secrets
// out of every descriptor / probe / result the agent sees. `fill` and `press`
// (and the multi-field `fill-form`) compose these helpers.

import type {
  ActionContext,
  DispatchedAction,
  ActionResult,
  ElementProbe,
} from "./actionresult.js";
import { refOrSelector, type ActionTarget } from "./locator.js";

/** Dispatch-side secret materialisation. Wraps `SecretRegistry.materialize`
 *  with a no-registry fallback so non-secrets callers don't need to feature-
 *  detect. Exported for composing primitives (e.g. multi-field fill). */
export function materialiseValue(
  ctx: ActionContext,
  raw: string,
): { ok: true; value: string; alias?: string } | { ok: false; error: string } {
  if (!ctx.secrets) return { ok: true, value: raw };
  const m = ctx.secrets.materialize(raw, ctx.page.url());
  if (!m.ok) return { ok: false, error: m.error! };
  return m.alias ? { ok: true, value: m.value, alias: m.alias } : { ok: true, value: m.value };
}

/** Build a clean ActionResult-shaped failure for a secrets-materialisation
 *  rejection (no Playwright op ever runs). Mirrors the action-window error
 *  envelope so the agent sees a consistent shape. */
export function failedFill(target: ActionTarget, value: string, message: string): ActionResult {
  return secretsFailure({ type: "fill", value, ...refOrSelector(target) }, message);
}
export function failedPress(
  target: ActionTarget | undefined,
  key: string,
  message: string,
): ActionResult {
  return secretsFailure(
    { type: "press", value: key, ...(target ? refOrSelector(target) : {}) },
    message,
  );
}
function secretsFailure(action: DispatchedAction, message: string): ActionResult {
  return {
    ok: false,
    action,
    navigation: { changed: false, from: "", to: "", kind: null },
    structure: { appeared: [], removed: [], newTabs: [] },
    console: { errors: [], warnings: 0 },
    pageErrors: [],
    network: { summary: { total: 0, byType: {}, failed: 0 } },
    tokensEstimate: 0,
    warnings: [],
    error: message,
  };
}

/** Post-probe defence-in-depth: mask any registered real-value that leaked
 *  into the probe's `value` / `displayText` / `ownerControl` / `container`
 *  string fields. The fill / press path is the canonical source of these
 *  leaks — the field's DOM value reflects what we just typed.
 *  Exported for composing primitives (e.g. multi-field fill). */
export function maskProbe(probed: ElementProbe | void, ctx: ActionContext): ElementProbe | void {
  if (!probed || !ctx.secrets) return probed;
  const out: ElementProbe = { ...probed };
  if (typeof out.value === "string") out.value = ctx.secrets.applyMaskInText(out.value);
  if (typeof out.displayText === "string")
    out.displayText = ctx.secrets.applyMaskInText(out.displayText);
  if (out.ownerControl) {
    const oc = { ...out.ownerControl };
    if (oc.displayTextBefore)
      oc.displayTextBefore = ctx.secrets.applyMaskInText(oc.displayTextBefore);
    if (oc.displayTextAfter) oc.displayTextAfter = ctx.secrets.applyMaskInText(oc.displayTextAfter);
    if (oc.label) oc.label = ctx.secrets.applyMaskInText(oc.label);
    out.ownerControl = oc;
  }
  if (out.container) {
    const c = { ...out.container };
    if (c.rowKey) c.rowKey = ctx.secrets.applyMaskInText(c.rowKey);
    if (c.rowText) c.rowText = ctx.secrets.applyMaskInText(c.rowText);
    out.container = c;
  }
  return out;
}
