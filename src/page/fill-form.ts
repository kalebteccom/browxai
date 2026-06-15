// Multi-field form-fill primitive. Fills N field/value pairs atomically in
// one action window, with an optional final `submit` click — replaces the
// fill/fill/fill/click round-trip pattern with a single dispatch.
//
// Semantics that callers can rely on:
//
//   1. **Atomic pre-resolution.** Every field's target (ref / selector /
//      coords) is resolved BEFORE any DOM write. If any target fails to
//      resolve, the call returns `ok:false` with a structured
//      `fieldResolution` block listing every field's outcome — and *no*
//      partial fills land. The agent gets a single "this form isn't ready"
//      signal instead of a half-filled form that's hard to recover from.
//
//   2. **Sequential dispatch.** Once resolution succeeds, fields are filled
//      in array order. Each fill goes through the same Playwright `.fill()`
//      path the single-field primitive uses; per-field secrets materialisation
//      and post-probe masking compose unchanged. The first per-field error
//      stops the loop; later fields are reported as `skipped` so the agent
//      can see how far the dispatch got.
//
//   3. **Per-field probes.** The result carries `elements: ElementProbe[]`
//      in dispatch order — the multi-target variant of the single-field
//      `element` probe. When a submit is supplied, `element` (singular) is
//      the submit's post-click probe so single-target consumers don't have
//      to feature-detect.
//
//   4. **One action window.** Navigation / network / structure / console /
//      pageErrors / snapshotDelta are captured ACROSS the whole sequence,
//      not per field. The agent sees "did the form submit succeed?" at the
//      same envelope level as a one-field fill — one round-trip, one diff.

import type { Locator, Page } from "playwright-core";
import {
  runInActionWindow,
  type ActionContext,
  type DispatchedAction,
  type ActionResult,
  type ActionWindowOptions,
  type ElementProbe,
} from "./actionresult.js";
import { locatorFor, type ActionTarget } from "./locator.js";
import { materialiseValue, maskProbe, preProbe, probe } from "./actions.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface FillFormField {
  target: ActionTarget;
  value: string;
}

export interface FillFormArgs extends ActionWindowOptions {
  fields: FillFormField[];
  /** Optional submit target. Clicked after every field has filled
   *  successfully. Skipped when any field fails (atomic submit semantics —
   *  we don't submit a partially-filled form). */
  submit?: ActionTarget;
}

/** Per-field resolution outcome surfaced when the atomic pre-resolution
 *  step fails. `index` lines up with the input `fields[]` order. */
export interface FieldResolution {
  index: number;
  /** Compact identification of which target shape was passed — for
   *  agent-facing error messages. */
  targetSummary: string;
  ok: boolean;
  error?: string;
}

/** Per-field dispatch outcome included in the result's `elements` slot is
 *  the post-fill `ElementProbe`. When the atomic resolution step rejected
 *  the call, `elements` is omitted and `fieldResolution` (on the result
 *  envelope as an extension) carries the per-field outcomes. */
export interface FillFormResult extends ActionResult {
  /** Per-field resolution outcomes — only present when the atomic
   *  resolution step rejected the call (`ok:false`, no fills landed). */
  fieldResolution?: FieldResolution[];
  /** When a per-field fill failed mid-loop, the 0-based index of the
   *  offending field and a list of skipped indices. Distinguishes
   *  "rejected atomically" from "started filling then hit an app error". */
  fillFailure?: { atIndex: number; skipped: number[] };
}

/** Pure helper: render a one-line summary of an ActionTarget so the
 *  resolution-failure envelope is human-readable. Exported for unit tests. */
export function summariseTarget(t: ActionTarget): string {
  if (t.ref) return `ref=${t.ref}`;
  if (t.selector) {
    return t.contextRef ? `selector=${t.selector} (in ${t.contextRef})` : `selector=${t.selector}`;
  }
  if (t.coords) return `coords=${t.coords.x},${t.coords.y}`;
  return "<empty target>";
}

/** Pure helper: validate the args shape before touching the page. Throws
 *  on structural problems (empty fields, coord targets for fill — which
 *  Playwright can't drive). Exported for unit tests. */
export function validateFillFormArgs(args: FillFormArgs): void {
  if (!Array.isArray(args.fields) || args.fields.length === 0) {
    throw new Error("fill_form: `fields` must be a non-empty array of {target, value}");
  }
  for (let i = 0; i < args.fields.length; i++) {
    const f = args.fields[i]!;
    if (!f || typeof f !== "object") {
      throw new Error(`fill_form: fields[${i}] is not an object`);
    }
    if (typeof f.value !== "string") {
      throw new Error(`fill_form: fields[${i}].value must be a string`);
    }
    if (!f.target) {
      throw new Error(`fill_form: fields[${i}].target is required`);
    }
    if (f.target.coords) {
      throw new Error(
        `fill_form: fields[${i}] uses a coords target — fill requires a real input/textarea element, ` +
          `so pass ref/selector/named. coords stays for click/hover.`,
      );
    }
  }
}

/**
 * Resolve every field's locator and confirm it actually matches a node in
 * the DOM. Returns either `{ ok: true, locators, … }` (every field resolved
 * to ≥1 matching node) or `{ ok: false, resolutions }` (one or more misses;
 * caller emits a structured failure and runs NO writes).
 *
 * Exported for unit tests — the atomic-resolution invariant is the most
 * important part of the primitive, and we test it directly.
 */
/** Resolve one field/submit target into a locator + resolution record. `index`
 *  is the field index, or -1 for the submit target (which drives the zero-node
 *  error wording, preserving the prior byte-identical messages). */
async function resolveOneTarget(
  page: Page,
  refs: ActionContext["refs"],
  target: ActionTarget,
  index: number,
  targetSummary: string,
): Promise<{ locator?: Locator; resolution: FieldResolution }> {
  const zeroNodeError =
    index === -1
      ? "submit target resolved to zero DOM nodes"
      : "target resolved to zero DOM nodes — element no longer present";
  try {
    const loc = locatorFor(page, refs, target);
    // count() is the cheap "does this resolve" gate — surfaces "ref exists in
    // registry but no longer in the DOM" before we start typing.
    const count = await loc.count().catch(() => 0);
    if (count === 0) {
      return { resolution: { index, targetSummary, ok: false, error: zeroNodeError } };
    }
    return { locator: loc, resolution: { index, targetSummary, ok: true } };
  } catch (err) {
    return {
      resolution: {
        index,
        targetSummary,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function resolveFieldsAtomically(
  page: Page,
  refs: ActionContext["refs"],
  fields: FillFormField[],
  submit?: ActionTarget,
): Promise<
  | {
      ok: true;
      locators: Locator[];
      submitLocator?: Locator;
      resolutions: FieldResolution[];
    }
  | { ok: false; resolutions: FieldResolution[]; submitResolution?: FieldResolution }
> {
  const resolutions: FieldResolution[] = [];
  const locators: Locator[] = [];

  for (let i = 0; i < fields.length; i++) {
    const r = await resolveOneTarget(page, refs, fields[i]!.target, i, summariseTarget(fields[i]!.target));
    resolutions.push(r.resolution);
    if (r.locator) locators.push(r.locator);
  }

  let submitLocator: Locator | undefined;
  let submitResolution: FieldResolution | undefined;
  if (submit) {
    const r = await resolveOneTarget(page, refs, submit, -1, `submit ${summariseTarget(submit)}`);
    submitLocator = r.locator;
    submitResolution = r.resolution;
  }

  const allFieldsOk = resolutions.every((r) => r.ok);
  const submitOk = !submitResolution || submitResolution.ok;
  if (!allFieldsOk || !submitOk) {
    return { ok: false, resolutions, submitResolution };
  }
  return { ok: true, locators, submitLocator, resolutions };
}

/**
 * Build the dispatched-action descriptor for the result envelope. The
 * value field carries a compact "n field(s) [+submit]" tag so transcripts
 * stay greppable without dumping every field's value in plaintext.
 */
function descriptorFor(args: FillFormArgs): DispatchedAction {
  const n = args.fields.length;
  const suffix = args.submit ? " +submit" : "";
  return { type: "fillForm", value: `${n} field${n === 1 ? "" : "s"}${suffix}` };
}

/**
 * Compose-with-existing-fill multi-field form primitive. See file header
 * for the contract. Failure envelopes mirror the action-window shape so
 * agents see the same `ok / action / navigation / structure / console …`
 * surface they get from every other action tool.
 */
/** Build the empty-window `ok:false` envelope for an atomic pre-flight rejection
 *  (no fields typed). Mirrors the action-window shape so callers see the same
 *  surface every action tool returns. */
function fillFormFailure(
  ctx: ActionContext,
  descriptor: DispatchedAction,
  error: string,
  fieldResolution: FieldResolution[],
): FillFormResult {
  const url = ctx.page.url();
  return {
    ok: false,
    action: descriptor,
    navigation: { changed: false, from: url, to: url, kind: null },
    structure: { appeared: [], removed: [], newTabs: [] },
    console: { errors: [], warnings: 0 },
    pageErrors: [],
    network: { summary: { total: 0, byType: {}, failed: 0 } },
    tokensEstimate: 0,
    warnings: [],
    error,
    fieldResolution,
  };
}

/** Materialise every field's value (resolving registered-secret aliases) before
 *  any write. Returns the materialised values or a pre-flight failure (a
 *  rejection on field 3 mustn't leave 0..2 filled). */
function materialiseFields(
  ctx: ActionContext,
  args: FillFormArgs,
  descriptor: DispatchedAction,
  fieldResolution: FieldResolution[],
):
  | { ok: true; materialised: Array<{ value: string; alias?: string; descriptorValue: string }> }
  | { ok: false; failure: FillFormResult } {
  const materialised: Array<{ value: string; alias?: string; descriptorValue: string }> = [];
  for (let i = 0; i < args.fields.length; i++) {
    const f = args.fields[i]!;
    const mat = materialiseValue(ctx, f.value);
    if (!mat.ok) {
      return {
        ok: false,
        failure: fillFormFailure(
          ctx,
          descriptor,
          `fill_form: secrets materialisation rejected fields[${i}]: ${mat.error}`,
          fieldResolution,
        ),
      };
    }
    materialised.push({
      value: mat.value,
      alias: mat.alias,
      descriptorValue: mat.alias ? `<${mat.alias}>` : f.value,
    });
  }
  return { ok: true, materialised };
}

export async function fillForm(ctx: ActionContext, args: FillFormArgs): Promise<FillFormResult> {
  validateFillFormArgs(args);

  const descriptor = descriptorFor(args);

  // Atomic pre-resolution happens BEFORE we open the action window — a
  // resolution failure shouldn't pay for a network tap + a11y pre-tree.
  const resolution = await resolveFieldsAtomically(ctx.page, ctx.refs, args.fields, args.submit);
  if (!resolution.ok) {
    const allResolutions = [
      ...resolution.resolutions,
      ...(resolution.submitResolution ? [resolution.submitResolution] : []),
    ];
    const missedSummaries = allResolutions
      .filter((r) => !r.ok)
      .map((r) => `[${r.index}] ${r.targetSummary}: ${r.error}`)
      .join("; ");
    return fillFormFailure(
      ctx,
      descriptor,
      `fill_form: atomic pre-resolution rejected the call — no fields were typed. Misses: ${missedSummaries}`,
      allResolutions,
    );
  }

  // Pre-validate secrets materialisation for every field too (same "fail
  // atomically before writing" posture).
  const mat = materialiseFields(ctx, args, descriptor, resolution.resolutions);
  if (!mat.ok) return mat.failure;
  const materialised = mat.materialised;

  // ---- single action window across the whole sequence ----
  // The body returns the *final* probe (submit's post-click probe if a
  // submit was supplied; else the last field's post-fill probe). Per-field
  // probes accumulate on the shared `perField` array and are attached to
  // the result on the way out so callers see them under `elements`.
  const perField: ElementProbe[] = [];
  let fillFailure: { atIndex: number; skipped: number[] } | undefined;

  const result = await runInActionWindow(ctx, descriptor, args, async () => {
    let finalProbe: ElementProbe | undefined;
    for (let i = 0; i < resolution.locators.length; i++) {
      const loc = resolution.locators[i]!;
      const m = materialised[i]!;
      const target = args.fields[i]!.target;
      try {
        const pre = await preProbe(loc);
        await loc.fill(m.value, { timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });
        const probed = await probe(loc, target, m.descriptorValue, pre);
        const masked = maskProbe(probed, ctx) as ElementProbe;
        perField.push(masked);
        finalProbe = masked;
      } catch (err) {
        // Mid-loop fill failure. Record the skipped tail so the agent can
        // see how far the dispatch got, then rethrow — the action-window
        // catches it and surfaces the structured `ok:false` envelope.
        const skipped: number[] = [];
        for (let j = i + 1; j < resolution.locators.length; j++) skipped.push(j);
        fillFailure = { atIndex: i, skipped };
        // Push a stub probe so per-field positions align with the input
        // array — the failing index carries `stillAttached:false` so the
        // agent doesn't have to count.
        perField.push({ ref: target.ref, stillAttached: false });
        throw err;
      }
    }

    if (resolution.submitLocator) {
      const pre = await preProbe(resolution.submitLocator);
      await resolution.submitLocator.click({ timeout: args.deadlineMs ?? DEFAULT_TIMEOUT_MS });
      finalProbe = await probe(resolution.submitLocator, args.submit!, undefined, pre);
    }

    return finalProbe;
  });

  // Attach per-field probes + fillFailure to the result.
  const out: FillFormResult = result;
  if (perField.length > 0) out.elements = perField;
  if (fillFailure) out.fillFailure = fillFailure;
  return out;
}
