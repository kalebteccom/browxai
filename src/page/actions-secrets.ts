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
import type { Frame, Locator, Page } from "playwright-core";
import { refOrSelector, type ActionTarget } from "./locator.js";

/** Which frame receives a value. A thunk yields the target locator (the value
 *  lands in the frame that owns its element); `"focused"` is a targetless
 *  keyboard press (the value lands in the focused frame); `undefined` means no
 *  frame is involved and the main frame stands in. */
export type SecretReceiver = (() => Locator) | "focused" | undefined;

type Materialised = { ok: true; value: string; alias?: string } | { ok: false; error: string };

/** How deep the focused-frame walk descends before it stops. */
const MAX_FRAME_DEPTH = 16;

/** Dispatch-side secret materialisation. Wraps `SecretRegistry.materialize`
 *  with a no-registry fallback so non-secrets callers don't need to feature-
 *  detect. A scoped alias is checked against the URL of the frame that
 *  receives it, resolved from `receiver`. Exported for composing primitives
 *  (e.g. multi-field fill). */
export async function materialiseValue(
  ctx: ActionContext,
  raw: string,
  receiver?: SecretReceiver,
  timeoutMs = 5_000,
): Promise<Materialised> {
  if (!ctx.secrets) return { ok: true, value: raw };
  let url = ctx.page.url();
  if (ctx.secrets.needsScopeCheck(raw)) {
    try {
      url = await receivingFrameUrl(ctx.page, receiver, timeoutMs);
    } catch (e) {
      return {
        ok: false,
        error:
          `secret "${raw}" is scoped, and the frame that would receive it could not be ` +
          `resolved: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  const m = ctx.secrets.materialize(raw, url);
  if (!m.ok) return { ok: false, error: m.error! };
  return m.alias ? { ok: true, value: m.value, alias: m.alias } : { ok: true, value: m.value };
}

/** The URL of the frame a value would land in. Everything read here comes
 *  from Playwright's frame tree and its isolated selector engine, never from
 *  a value the page's own scripts could rewrite. */
async function receivingFrameUrl(
  page: Page,
  receiver: SecretReceiver,
  timeoutMs: number,
): Promise<string> {
  if (receiver === undefined) return page.url();
  if (receiver === "focused") return (await focusedFrame(page)).url();
  const handle = await receiver().elementHandle({ timeout: timeoutMs });
  try {
    const frame = await handle.ownerFrame();
    if (!frame) throw new Error("the target element has no owner frame");
    return frame.url();
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

/** The frame a targetless key press lands in: descend from the main frame
 *  through each focused `<iframe>` / `<frame>` owner element. */
async function focusedFrame(page: Page): Promise<Frame> {
  let frame = page.mainFrame();
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
    const owner = frame.locator("iframe:focus, frame:focus");
    if ((await owner.count()) === 0) break;
    const handle = await owner.first().elementHandle({ timeout: 1_000 });
    const child = await handle.contentFrame();
    await handle.dispose().catch(() => undefined);
    if (!child) break;
    frame = child;
  }
  return frame;
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
