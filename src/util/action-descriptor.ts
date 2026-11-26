// The plan/execute descriptor: the serialisable shape `plan()` returns and
// `execute()` takes back. It lives in util because two layers read it: the page
// layer builds and dispatches it (`src/page/plan.ts`, which re-exports every name
// here), and `flake-check.ts` in this directory caches it between runs. Plain
// data only, so util stays the leaf of the import graph.

/** How durable a candidate's selector is: "high" = tier-1 testid, "medium" =
 *  role+name, "low" = tier 4-5 fallback. */
export type SelectorStability = "high" | "medium" | "low";

/** Whether an element can be acted on right now. `true` = visible + enabled +
 *  on-screen; the strings say why not. */
export type Actionability = true | "disabled" | "off-screen" | "covered";

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
  stability: SelectorStability;
  /** The picked candidate's role / name / testId. */
  role: string;
  name?: string;
  testId?: string;
  /** The picked candidate's score under `find()`'s ranker. */
  score: number;
  /** Whether the candidate was visible+enabled+on-screen at plan time. */
  actionable: Actionability;
  /** Whether `find()` issued any warnings (low confidence, no visible
   *  candidate, etc.). Caller can refuse to execute on this signal. */
  warnings: string[];
  /** Up to 4 lower-ranked alternatives (without `selectorHint` repetition).
   *  Useful when an agent wants to retry against a sibling after a failure. */
  alternatives: Array<{ ref: string; role: string; name?: string; testId?: string; score: number }>;
}
