// `plan()` / `execute()` — separate intent capture from dispatch.
//
// `plan()` resolves a natural-language query (via the same scoring as `find()`)
// down to a single bound, serialisable `ActionDescriptor` carrying:
//   - the action `verb` (`click` / `fill` / `hover` / `press` / `select`),
//   - the verb's structured `args` (the `value` for `fill`, `key` for `press`, etc.),
//   - the resolved `ref` (the existing stable-key namespace — NOT a parallel id system),
//   - the `evidence` (selectorHint, stability, score, top-N candidates) the caller
//     can audit before deciding to execute,
//   - an `expiresAt` deadline (epoch-ms).
//
// `execute(descriptor)` then re-resolves the ref via `refs.ts` and dispatches the
// verb's action against the live page. Two structured failure modes:
//
//   - `error: "descriptor expired"`     → past `expiresAt`. Caller should re-`plan`.
//   - `error: "ref no longer resolves"` → the ref is no longer in the registry, or
//                                          the underlying locator no longer addresses
//                                          a live element. Caller should re-`plan`.
//
// Explicit non-goal — mock dispatch. `execute()` actually runs the action; the
// value here is *capturing and replaying intent*, not *suppressing effects*.
// (An action that fakes its effect is a footgun — the agent thinks it ran
// something it didn't.) For a no-effect-but-want-to-see-the-target dry-run,
// inspect the returned descriptor's `evidence` block before calling `execute`.

import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "playwright-core";
import { find, type FindCandidate } from "./find.js";
import type { SnapshotSubstrate } from "./snapshot-substrate.js";
import type { RefRegistry } from "./refs.js";
import type { ActionContext, ActionResult } from "./actionresult.js";
import * as actions from "./actions.js";

/** Action verbs `plan()`/`execute()` understand. Single-target verbs only —
 *  page-level / multi-step verbs (`navigate`, `scroll`, `wait_for`, `choose_option`)
 *  are out of scope here; they're either trivially planned (`navigate(url)` doesn't
 *  need a ranked candidate) or expand into multiple action-window dispatches and
 *  belong in their own primitives. */
export const PLAN_VERBS = ["click", "fill", "hover", "press", "select"] as const;
export type PlanVerb = (typeof PLAN_VERBS)[number];

/** Per-verb args envelope. `value` is the typed-in string for `fill`, `values`
 *  the option list for `select`, `key` the Playwright key syntax for `press`,
 *  `button` the mouse button for `click`. Click / hover have no extra args
 *  beyond the descriptor's bound `ref`. */
export interface PlanVerbArgs {
  /** `fill` value. */
  value?: string;
  /** `select` option labels/values. */
  values?: string[];
  /** `press` key. */
  key?: string;
  /** `click` mouse button (default left). */
  button?: "left" | "right" | "middle";
}

/** The plan/execute envelope. The agent receives one, may inspect it, may
 *  cache it, and later hands it back verbatim to `execute()`. */
export interface ActionDescriptor {
  /** Stable id for this descriptor (not a ref — a descriptor id; useful for
   *  caches that key on "this plan attempt"). */
  id: string;
  /** The bound element ref. Uses the **same** `eN` namespace as `find()` /
   *  `snapshot()` / `name_ref` — descriptors do NOT have a parallel id system. */
  ref: string;
  /** Action verb to dispatch. */
  verb: PlanVerb;
  /** Verb-specific args. Empty `{}` for click/hover with default button. */
  args: PlanVerbArgs;
  /** Evidence captured at plan time so the caller can decide whether to execute. */
  evidence: PlanEvidence;
  /** Epoch-ms past which `execute()` returns a structured "descriptor expired"
   *  failure. Defaults to `plan() + 60_000`. */
  expiresAt: number;
}

export interface PlanEvidence {
  query: string;
  /** The top candidate's selectorHint — the same string `find()` would emit. */
  selectorHint: string;
  /** Tier (1–5) and stability (high/medium/low) of the picked locator. */
  selectorTier: 1 | 2 | 3 | 4 | 5;
  stability: FindCandidate["stability"];
  /** The picked candidate's role / name / testId. */
  role: string;
  name?: string;
  testId?: string;
  /** The picked candidate's score under `find()`'s ranker. */
  score: number;
  /** Whether the candidate was visible+enabled+on-screen at plan time. */
  actionable: FindCandidate["actionable"];
  /** Whether `find()` issued any warnings (low confidence, no visible
   *  candidate, etc.). Caller can refuse to execute on this signal. */
  warnings: string[];
  /** Up to 4 lower-ranked alternatives (without `selectorHint` repetition).
   *  Useful when an agent wants to retry against a sibling after a failure. */
  alternatives: Array<{ ref: string; role: string; name?: string; testId?: string; score: number }>;
}

export interface PlanOptions {
  query: string;
  verb: PlanVerb;
  /** Verb args. Required ones (value for fill, key for press, values for
   *  select) are validated by `plan()` itself, not at `execute()` time — the
   *  point is to fail fast at capture, not at dispatch. */
  verbArgs?: PlanVerbArgs;
  /** Same semantics as `find()`'s `contextRef` — scope the candidate walk
   *  to this ref's subtree. */
  contextRef?: string;
  /** Same semantics as `find()` — return no descriptor if no candidate
   *  scored above the floor. Default 0 (off). */
  confidenceFloor?: number;
  /** Descriptor lifetime in ms. Default 60_000 (1 minute). Clamped to
   *  [1_000, 30 * 60_000] (1s..30min) — anything longer is almost certainly
   *  a misuse (the page WILL have moved on; re-plan instead). */
  ttlMs?: number;
  /** Configured test-attribute list, same as `find()`. */
  testAttributes: string[];
  /** Capability-aware fallback hints for the underlying `find()` call. */
  fallbackHints?: { coords: boolean; evalJs: boolean };
}

export type PlanOutcome =
  | { ok: true; descriptor: ActionDescriptor; warnings: string[]; tokensEstimate: number }
  | { ok: false; error: string; warnings: string[]; tokensEstimate: number };

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 30 * 60_000;

/** Validate per-verb args at plan time so a bad descriptor can never reach
 *  `execute()`. Pure; exported for tests. */
export function validateVerbArgs(verb: PlanVerb, args: PlanVerbArgs | undefined): string | null {
  const a = args ?? {};
  if (verb === "fill") {
    if (typeof a.value !== "string") return 'plan: verb "fill" requires verbArgs.value (string)';
  }
  if (verb === "press") {
    if (typeof a.key !== "string" || a.key.length === 0)
      return 'plan: verb "press" requires verbArgs.key (non-empty string)';
  }
  if (verb === "select") {
    if (!Array.isArray(a.values) || a.values.length === 0)
      return 'plan: verb "select" requires verbArgs.values (non-empty string[])';
  }
  if (verb === "click") {
    if (a.button !== undefined && !["left", "right", "middle"].includes(a.button)) {
      return `plan: verb "click" — button must be left/right/middle (got ${JSON.stringify(a.button)})`;
    }
  }
  return null;
}

/** Clamp a caller-supplied ttl into the sane range. Pure; exported for tests. */
export function clampTtl(ttlMs: number | undefined): number {
  const v = typeof ttlMs === "number" && Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS;
  return Math.min(Math.max(v, MIN_TTL_MS), MAX_TTL_MS);
}

/** Project a `find()` candidate into a descriptor's `evidence` block.
 *  Pure; exported for tests. */
export function evidenceFromCandidate(
  query: string,
  picked: FindCandidate,
  alternatives: FindCandidate[],
  warnings: string[],
): PlanEvidence {
  const alts = alternatives.slice(0, 4).map((c) => {
    const a: PlanEvidence["alternatives"][number] = { ref: c.ref, role: c.role, score: c.score };
    if (c.name !== undefined) a.name = c.name;
    if (c.testId !== undefined) a.testId = c.testId;
    return a;
  });
  const ev: PlanEvidence = {
    query,
    selectorHint: picked.selectorHint,
    selectorTier: picked.selectorTier,
    stability: picked.stability,
    role: picked.role,
    score: picked.score,
    actionable: picked.actionable,
    warnings,
    alternatives: alts,
  };
  if (picked.name !== undefined) ev.name = picked.name;
  if (picked.testId !== undefined) ev.testId = picked.testId;
  return ev;
}

/** Build a descriptor from a resolved candidate + caller args. Pure; exported
 *  for tests. */
export function buildDescriptor(args: {
  picked: FindCandidate;
  alternatives: FindCandidate[];
  query: string;
  verb: PlanVerb;
  verbArgs: PlanVerbArgs;
  warnings: string[];
  ttlMs: number;
  now?: number;
}): ActionDescriptor {
  const now = args.now ?? Date.now();
  return {
    id: randomUUID(),
    ref: args.picked.ref,
    verb: args.verb,
    args: { ...args.verbArgs },
    evidence: evidenceFromCandidate(args.query, args.picked, args.alternatives, args.warnings),
    expiresAt: now + args.ttlMs,
  };
}

/** rough JSON-byte/4 token estimate for a descriptor — matches the
 *  shape `tokensEstimate` uses across other tools. Pure; exported for tests. */
export function estimateDescriptorTokens(d: ActionDescriptor): number {
  return Math.ceil(JSON.stringify(d).length / 4);
}

/**
 * `plan()`: rank `query` against the live tree, pick the top candidate,
 * validate the verb's args, return a serialisable descriptor (no dispatch).
 *
 * Returns `{ ok: false }` with structured reasons when:
 *   - the verb's required args are missing/wrong-shape (validated up front),
 *   - `find()` returned no candidates (or none above `confidenceFloor`).
 *
 * Note: a descriptor IS returned even if the top candidate is non-actionable
 * (off-screen / disabled). The caller can inspect `evidence.actionable` and
 * decide; we don't silently refuse to plan against a hidden modal, because
 * sometimes that's exactly what the caller wants to confirm.
 */
export async function plan(
  page: Page,
  substrate: SnapshotSubstrate,
  refs: RefRegistry,
  opts: PlanOptions,
  /** CDP handle for find()'s visible-rect bbox fast path — chromium only. */
  cdp?: CDPSession,
): Promise<PlanOutcome> {
  const argError = validateVerbArgs(opts.verb, opts.verbArgs);
  if (argError) {
    return { ok: false, error: argError, warnings: [], tokensEstimate: 0 };
  }
  const ttlMs = clampTtl(opts.ttlMs);

  const result = await find(
    page,
    substrate,
    refs,
    {
      query: opts.query,
      testAttributes: opts.testAttributes,
      contextRef: opts.contextRef,
      confidenceFloor: opts.confidenceFloor,
      fallbackHints: opts.fallbackHints,
      // bound the candidate list so evidence.alternatives stays small (we
      // only ever return the top + up to 4 alts).
      maxCandidates: 5,
    },
    cdp,
  );

  if (result.candidates.length === 0) {
    return {
      ok: false,
      error: `plan: no candidate matched query ${JSON.stringify(opts.query)}`,
      warnings: result.warnings,
      tokensEstimate: 0,
    };
  }

  const [picked, ...rest] = result.candidates;
  if (!picked) {
    return {
      ok: false,
      error: `plan: no candidate matched query ${JSON.stringify(opts.query)}`,
      warnings: result.warnings,
      tokensEstimate: 0,
    };
  }
  const descriptor = buildDescriptor({
    picked,
    alternatives: rest,
    query: opts.query,
    verb: opts.verb,
    verbArgs: opts.verbArgs ?? {},
    warnings: result.warnings,
    ttlMs,
  });
  return {
    ok: true,
    descriptor,
    warnings: result.warnings,
    tokensEstimate: estimateDescriptorTokens(descriptor),
  };
}

/** structured `execute()` failure shape — distinguishes a *dispatched*
 *  ActionResult (the dispatch ran; ok=true|false reflects the action's outcome)
 *  from a *refused* dispatch (descriptor expired / ref gone) where the action
 *  was never attempted. */
export type ExecuteOutcome =
  | { ok: true; result: ActionResult; tokensEstimate: number }
  | {
      ok: false;
      error: string;
      reason: "expired" | "ref-gone" | "invalid";
      tokensEstimate: number;
    };

/** Reasons we may refuse to dispatch a descriptor without ever running it. */
export type ExecuteRefusal = Exclude<ExecuteOutcome, { ok: true }>;

export interface ExecuteOptions {
  /** Optional dispatch-window overrides (mode/maxResultTokens/timeoutMs/
   *  recordingHint flow through to the underlying action). Mirrors
   *  `ActionWindowOptions` but the descriptor itself is the source of truth
   *  for the target. */
  mode?: import("./actionresult.js").SnapshotMode;
  maxResultTokens?: number;
  deadlineMs?: number;
  deadlineWarning?: string;
  recordingHint?: { selectorHint: string; stability?: FindCandidate["stability"] };
  /** Override "now" — for tests of expiry semantics. */
  now?: number;
}

/** Static descriptor validation (shape only — does not touch the page).
 *  Pure; exported for tests. */
export function validateDescriptor(
  d: unknown,
): { ok: true; descriptor: ActionDescriptor } | { ok: false; error: string } {
  if (!d || typeof d !== "object")
    return { ok: false, error: "execute: descriptor must be an object" };
  const obj = d as Record<string, unknown>;
  if (typeof obj.id !== "string")
    return { ok: false, error: "execute: descriptor.id missing or not a string" };
  if (typeof obj.ref !== "string")
    return { ok: false, error: "execute: descriptor.ref missing or not a string" };
  if (typeof obj.verb !== "string" || !(PLAN_VERBS as readonly string[]).includes(obj.verb)) {
    return { ok: false, error: `execute: descriptor.verb must be one of ${PLAN_VERBS.join("/")}` };
  }
  if (typeof obj.expiresAt !== "number")
    return { ok: false, error: "execute: descriptor.expiresAt missing or not a number" };
  if (typeof obj.args !== "object" || obj.args === null)
    return { ok: false, error: "execute: descriptor.args must be an object" };
  // evidence is informational — present-but-malformed should not block
  // dispatch, but it must be at least an object so callers can rely on
  // `descriptor.evidence.selectorHint` being readable when present.
  if (obj.evidence !== undefined && (typeof obj.evidence !== "object" || obj.evidence === null)) {
    return { ok: false, error: "execute: descriptor.evidence must be an object when present" };
  }
  return { ok: true, descriptor: obj as unknown as ActionDescriptor };
}

/**
 * `execute(descriptor)`: dispatch a previously-planned descriptor. Re-resolves
 * the ref via `refs.ts` (the same stable-key scheme `find()`/`snapshot()` use),
 * runs the verb's action, and returns the dispatched `ActionResult`.
 *
 * Refusal modes (no dispatch happens):
 *   - `reason: "expired"` — past `expiresAt`.
 *   - `reason: "ref-gone"` — `refs.has(descriptor.ref)` is false. The agent
 *                            should re-`plan` against the current snapshot.
 *   - `reason: "invalid"` — descriptor failed shape validation (bad verb,
 *                           missing fields, malformed args).
 *
 * Capability gating: this function does NOT enforce capabilities itself — the
 * MCP `execute` handler runs `gateCheck(verb)` (e.g. `gateCheck("click")`)
 * before calling in, so a descriptor with `verb: "click"` is denied when the
 * `action` capability is disabled, surfacing the *underlying* capability error
 * (not a generic "execute denied").
 */
/** Pre-flight validation for `execute`: schema, expiry, ref-presence, and
 *  re-validated verb args. Returns the validated descriptor or a failure
 *  outcome to return verbatim. */
function validateForExecute(
  ctx: ActionContext,
  rawDescriptor: unknown,
  now: number,
): { ok: true; descriptor: ActionDescriptor } | { ok: false; outcome: ExecuteOutcome } {
  const validated = validateDescriptor(rawDescriptor);
  if (!validated.ok) {
    return {
      ok: false,
      outcome: { ok: false, error: validated.error, reason: "invalid", tokensEstimate: 0 },
    };
  }
  const d = validated.descriptor;
  if (now > d.expiresAt) {
    return {
      ok: false,
      outcome: {
        ok: false,
        error: `execute: descriptor expired (${now - d.expiresAt}ms past expiresAt). Re-plan against the current snapshot.`,
        reason: "expired",
        tokensEstimate: 0,
      },
    };
  }
  if (!ctx.refs.has(d.ref)) {
    return {
      ok: false,
      outcome: {
        ok: false,
        error:
          `execute: ref "${d.ref}" no longer in the session's registry — the page likely re-snapshotted ` +
          `to a tree where the bound element is absent. Re-plan against the current snapshot.`,
        reason: "ref-gone",
        tokensEstimate: 0,
      },
    };
  }
  // Re-validate verb args at execute time too — a hand-edited descriptor could
  // have dropped a required arg between plan and execute.
  const argError = validateVerbArgs(d.verb, d.args);
  if (argError) {
    return {
      ok: false,
      outcome: { ok: false, error: argError, reason: "invalid", tokensEstimate: 0 },
    };
  }
  return { ok: true, descriptor: d };
}

export async function execute(
  ctx: ActionContext,
  rawDescriptor: unknown,
  opts: ExecuteOptions = {},
): Promise<ExecuteOutcome> {
  const now = opts.now ?? Date.now();
  const pre = validateForExecute(ctx, rawDescriptor, now);
  if (!pre.ok) return pre.outcome;
  const d = pre.descriptor;

  const target = { ref: d.ref };
  // Forwarded window options. We don't override the underlying action's
  // recordingHint plumbing here — the server-level handler computes one from
  // the ref (mirroring how `click`/`fill` are registered).
  const windowOpts = {
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.maxResultTokens !== undefined ? { maxResultTokens: opts.maxResultTokens } : {}),
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    ...(opts.deadlineWarning !== undefined ? { deadlineWarning: opts.deadlineWarning } : {}),
    ...(opts.recordingHint !== undefined ? { recordingHint: opts.recordingHint } : {}),
  };

  let result: ActionResult;
  switch (d.verb) {
    case "click":
      result = await actions.click(ctx, {
        target,
        ...(d.args.button ? { button: d.args.button } : {}),
        ...windowOpts,
      });
      break;
    case "fill":
      result = await actions.fill(ctx, { target, value: d.args.value!, ...windowOpts });
      break;
    case "hover":
      result = await actions.hover(ctx, { target, ...windowOpts });
      break;
    case "press":
      result = await actions.press(ctx, { target, key: d.args.key!, ...windowOpts });
      break;
    case "select":
      result = await actions.select(ctx, { target, values: d.args.values!, ...windowOpts });
      break;
  }

  return {
    ok: true,
    result,
    tokensEstimate: result.tokensEstimate,
  };
}
