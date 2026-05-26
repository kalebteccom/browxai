// Flake-check — run the same `batch` payload N times and report what shifted
// between runs. Composes existing primitives (no parallel dispatcher, no
// parallel action surface): `runBatch` is the inner runner; the cached-selector
// artifact uses the `ActionDescriptor` shape already shipped with `plan`/
// `execute`. Diagnoses AND fixes — green runs produce a `{step → resolved
// ref/selectorHint}` map a follow-up run can replay against (the Stagehand
// self-heal trick).
//
// Determining "the step landed identically" — judgment captured here so the
// next reader doesn't have to reconstruct it:
//
//   1. Strict resolution-signature match. Where the inner tool's result carries
//      a resolution payload — `plan` returns a descriptor with `ref` +
//      `evidence.selectorHint`; `find` returns a candidate list with `ref` +
//      `selectorHint` — we use `<ref>::<selectorHint>` as the signature.
//      Identical only when every green run produced the same pair.
//
//   2. Bound-target steps (click/fill/etc. called with a fixed `ref`/`selector`/
//      `named`) have no candidate ranker to disagree about — their signature
//      is just the supplied target string. They contribute a cached entry
//      iff every green run reported ok=true. (The artifact is the same input
//      the original call used — the value is the per-step pass/fail summary,
//      not a new resolver.)
//
//   3. Steps where the runs produced different signatures get NO cached entry.
//      `variance.signatures[step]` lists what was seen so the agent can decide.
//
// This module is intentionally dep-free below `runBatch` — unit tests can
// exercise the variance / cache logic without standing up the MCP server.

import { runBatch, type BatchCall, type BatchOptions, type BatchReport, type BatchEntry } from "./batch.js";
import type { ActionDescriptor, PlanEvidence } from "../page/plan.js";

export interface FlakeCheckOptions extends BatchOptions {
  /** How many times to run the same call sequence. Bounded by the caller
   *  schema (3..20) — the impl tolerates anything ≥1 so unit tests stay
   *  lightweight, but the MCP surface enforces the documented range. */
  n: number;
  /** Short-circuit when `stopOnAllGreen` consecutive runs all-pass. Off by
   *  default — set to a number to opt in. */
  stopOnAllGreen?: number;
}

/** Per-step roll-up across all completed runs. */
export interface StepStats {
  /** Step index (0-based; matches the `calls[]` argument order). */
  step: number;
  /** Tool name (echoed for cross-reference; same as `calls[step].tool`). */
  tool: string;
  /** Echo of the call's label when supplied. */
  label?: string;
  /** Number of runs that reached this step. (When `runBatch` halts early on
   *  a failure earlier in the sequence, later steps never run — their `runs`
   *  count drops below `n`.) */
  runs: number;
  /** Number of those reaching-this-step runs where the step succeeded. */
  ok: number;
  /** `ok / runs` — null when the step was never reached. */
  successRate: number | null;
  /** Distinct error messages observed (deduped, capped at 8 entries for
   *  result-size sanity — anything noisier is itself the finding). */
  errors: string[];
  /** Distinct resolution signatures observed (`<ref>::<selectorHint>` for
   *  plan/find, or `target:<ref|selector|named>` for bound calls). One entry
   *  means the step landed identically across every run that reached it. */
  signatures: string[];
}

/** A `{step → cached resolver}` entry — the self-heal artifact. Shape mirrors
 *  the `ActionDescriptor` returned by `plan()` so a downstream caller can hand
 *  it to `execute()` directly (after re-snapshotting to refresh the ref). */
export interface CachedResolver {
  step: number;
  tool: string;
  label?: string;
  /** The resolved ref the step landed on (from plan/find result). */
  ref?: string;
  /** The `selectorHint` captured at plan/find time — what a downstream
   *  Playwright export would write. */
  selectorHint?: string;
  /** Carried only when the source step was a `plan` call — re-usable by a
   *  follow-up `execute` against a fresh snapshot. Note: `expiresAt` is
   *  echoed from the source run; the consumer is expected to re-plan if it's
   *  in the past. */
  descriptor?: Pick<ActionDescriptor, "ref" | "verb" | "args"> & {
    /** Carried for evidence-trail purposes only — caller should not trust
     *  the `score` / `actionable` fields if it intends to re-execute later. */
    evidence?: Pick<PlanEvidence, "selectorHint" | "selectorTier" | "stability" | "role" | "name" | "testId">;
  };
  /** How many of the reaching-this-step runs agreed on this resolver. The
   *  caller's read of `runs == n` + `agreedRuns == runs` is the "100% green"
   *  case where this cache is safe to replay. */
  agreedRuns: number;
}

export interface FlakeCheckReport {
  /** Number of inner-batch runs actually performed (may be < n when
   *  `stopOnAllGreen` short-circuited). */
  runsCompleted: number;
  /** True when every completed run passed every step. */
  allGreen: boolean;
  /** When `stopOnAllGreen` short-circuited, the count of consecutive all-green
   *  runs that triggered the break. Absent otherwise. */
  shortCircuitedAfter?: number;
  /** Per-step roll-up. Indexed by call-array position. */
  steps: StepStats[];
  /** Earliest step (0-based) where `ok` differed across the completed runs,
   *  or null when every run agreed on every step's pass/fail (whether that
   *  was all-green or all-red — agreement IS the finding). */
  firstDivergence: { step: number; tool: string; label?: string } | null;
  /** Cached resolvers for steps where every reaching-this-step run agreed on
   *  the resolution signature AND succeeded. Replay-safe in that strict
   *  sense — not a free pass past a `descriptor expired`. */
  cachedResolvers: CachedResolver[];
  /** Echo of the per-run BatchReports so the caller can drill in. Order is
   *  chronological. */
  runs: BatchReport[];
}

const MAX_DISTINCT_ERRORS_PER_STEP = 8;
const MAX_DISTINCT_SIGNATURES_PER_STEP = 8;

/**
 * Run `calls` repeatedly through `runBatch` and roll up variance + cached
 * resolvers. Always runs the inner batch with `stopOnError:false` so the
 * variance picture survives a mid-sequence failure (the whole point — knowing
 * step 4 sometimes fails AND that step 5 then also fails differently).
 */
export async function runFlakeCheck(calls: BatchCall[], opts: FlakeCheckOptions): Promise<FlakeCheckReport> {
  const n = Math.max(1, opts.n | 0);
  const runs: BatchReport[] = [];
  let consecutiveGreen = 0;
  let shortCircuitedAfter: number | undefined;

  for (let runIdx = 0; runIdx < n; runIdx++) {
    const report = await runBatch(calls, {
      allowed: opts.allowed,
      handlers: opts.handlers,
      // Variance-on-the-tail is the entire point — don't let a stopOnError
      // setting from the caller hide the variance picture.
      stopOnError: false,
    });
    runs.push(report);

    const green = report.failedAt === null && report.results.every((r) => r.ok);
    consecutiveGreen = green ? consecutiveGreen + 1 : 0;

    if (opts.stopOnAllGreen !== undefined && opts.stopOnAllGreen > 0 && consecutiveGreen >= opts.stopOnAllGreen) {
      shortCircuitedAfter = consecutiveGreen;
      break;
    }
  }

  const steps = rollUpSteps(calls, runs);
  const firstDivergence = findFirstDivergence(calls, runs);
  const cachedResolvers = extractCachedResolvers(calls, runs, steps);
  const allGreen = runs.every((r) => r.failedAt === null && r.results.every((e) => e.ok));

  const out: FlakeCheckReport = {
    runsCompleted: runs.length,
    allGreen,
    steps,
    firstDivergence,
    cachedResolvers,
    runs,
  };
  if (shortCircuitedAfter !== undefined) out.shortCircuitedAfter = shortCircuitedAfter;
  return out;
}

/** Pure; exported for unit tests. Walks every run's results and produces a
 *  per-step StepStats record. */
export function rollUpSteps(calls: BatchCall[], runs: BatchReport[]): StepStats[] {
  return calls.map((call, step) => {
    const entries: BatchEntry[] = [];
    for (const r of runs) {
      const e = r.results[step];
      if (e) entries.push(e);
    }
    const ok = entries.filter((e) => e.ok).length;
    const runsAt = entries.length;
    const errorSet = new Set<string>();
    for (const e of entries) {
      if (e.ok) continue;
      // `runBatch` only sets `entry.error` on its own failure surfaces (expect
      // mismatch / thrown handler / unknown tool). When the inner call returns
      // `{ok:false, error:"…"}`, the message lives on `entry.result.error` —
      // surface that too so the variance roll-up isn't blank when the inner
      // tool failed cleanly.
      const fromEntry = typeof e.error === "string" ? e.error : null;
      const fromResult = e.result && typeof e.result === "object" && typeof (e.result as { error?: unknown }).error === "string"
        ? (e.result as { error: string }).error
        : null;
      const msg = fromEntry ?? fromResult;
      if (msg) {
        errorSet.add(msg);
        if (errorSet.size >= MAX_DISTINCT_ERRORS_PER_STEP) break;
      }
    }
    const sigSet = new Set<string>();
    for (const e of entries) {
      const s = signatureFor(call, e);
      sigSet.add(s);
      if (sigSet.size >= MAX_DISTINCT_SIGNATURES_PER_STEP) break;
    }
    const stats: StepStats = {
      step,
      tool: call.tool,
      runs: runsAt,
      ok,
      successRate: runsAt === 0 ? null : ok / runsAt,
      errors: [...errorSet],
      signatures: [...sigSet],
    };
    if (call.label !== undefined) stats.label = call.label;
    return stats;
  });
}

/** Pure; exported for tests. Smallest step index where `ok` differed across
 *  the runs that reached that step. */
export function findFirstDivergence(calls: BatchCall[], runs: BatchReport[]): FlakeCheckReport["firstDivergence"] {
  for (let step = 0; step < calls.length; step++) {
    let seenOk = false;
    let seenFail = false;
    for (const r of runs) {
      const e = r.results[step];
      if (!e) continue;
      if (e.ok) seenOk = true;
      else seenFail = true;
      if (seenOk && seenFail) {
        const out: { step: number; tool: string; label?: string } = { step, tool: calls[step]!.tool };
        if (calls[step]!.label !== undefined) out.label = calls[step]!.label!;
        return out;
      }
    }
  }
  return null;
}

/** Pure; exported for tests. Builds the self-heal cache for steps where every
 *  reaching-this-step run agreed on the resolution signature AND succeeded.
 *  Steps with no extractable resolver (no ref/selectorHint payload + no bound
 *  target) yield no entry. */
export function extractCachedResolvers(
  calls: BatchCall[],
  runs: BatchReport[],
  steps: StepStats[],
): CachedResolver[] {
  const out: CachedResolver[] = [];
  for (let step = 0; step < calls.length; step++) {
    const call = calls[step]!;
    const stat = steps[step]!;
    // Only cache when every reaching-this-step run agreed and all succeeded.
    if (stat.runs === 0) continue;
    if (stat.ok !== stat.runs) continue;
    if (stat.signatures.length !== 1) continue;

    // Take the first reaching-this-step entry as the source (all agreed,
    // so any one is canonical).
    let source: BatchEntry | undefined;
    for (const r of runs) {
      const e = r.results[step];
      if (e) { source = e; break; }
    }
    if (!source) continue;

    const resolver = buildResolver(step, call, source);
    if (resolver) {
      resolver.agreedRuns = stat.runs;
      out.push(resolver);
    }
  }
  return out;
}

/** Pure; exported for tests. Computes a per-step resolution signature from
 *  the inner call + its result entry. */
export function signatureFor(call: BatchCall, entry: BatchEntry): string {
  // Plan: descriptor.ref + evidence.selectorHint.
  const planSig = planSignature(entry.result);
  if (planSig) return `plan:${planSig}`;
  // Find: top candidate ref + selectorHint.
  const findSig = findSignature(entry.result);
  if (findSig) return `find:${findSig}`;
  // Bound target: just the supplied target string (ref / selector / named).
  // Coords intentionally not cached — by construction non-replayable across
  // a re-render (see plan.ts's policy note).
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (typeof args.ref === "string") return `ref:${args.ref}`;
  if (typeof args.selector === "string") return `selector:${args.selector}`;
  if (typeof args.named === "string") return `named:${args.named}`;
  // No structured target — signature is the ok-ness plus a tool tag so
  // step success-rate still rolls up cleanly.
  return `${call.tool}:${entry.ok ? "ok" : "fail"}`;
}

interface PlanResultLike {
  ok?: boolean;
  descriptor?: {
    ref?: unknown;
    verb?: unknown;
    args?: unknown;
    evidence?: unknown;
  };
}

function planSignature(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as PlanResultLike;
  const d = r.descriptor;
  if (!d || typeof d !== "object") return null;
  const ref = typeof d.ref === "string" ? d.ref : null;
  if (!ref) return null;
  const ev = d.evidence;
  const hint = ev && typeof ev === "object" && typeof (ev as { selectorHint?: unknown }).selectorHint === "string"
    ? (ev as { selectorHint: string }).selectorHint
    : "";
  return `${ref}::${hint}`;
}

interface FindResultLike {
  ok?: boolean;
  candidates?: Array<{ ref?: unknown; selectorHint?: unknown }>;
}

function findSignature(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as FindResultLike;
  if (!Array.isArray(r.candidates) || r.candidates.length === 0) return null;
  const top = r.candidates[0]!;
  const ref = typeof top.ref === "string" ? top.ref : null;
  if (!ref) return null;
  const hint = typeof top.selectorHint === "string" ? top.selectorHint : "";
  return `${ref}::${hint}`;
}

function buildResolver(step: number, call: BatchCall, source: BatchEntry): CachedResolver | null {
  const base: CachedResolver = { step, tool: call.tool, agreedRuns: 0 };
  if (call.label !== undefined) base.label = call.label;

  // plan() — richest cache (full descriptor projection).
  const planDescriptor = extractPlanDescriptor(source.result);
  if (planDescriptor) {
    base.ref = planDescriptor.ref;
    base.selectorHint = planDescriptor.evidence?.selectorHint;
    base.descriptor = planDescriptor;
    return base;
  }

  // find() — top candidate's ref + selectorHint.
  const findTop = extractFindTop(source.result);
  if (findTop) {
    base.ref = findTop.ref;
    base.selectorHint = findTop.selectorHint;
    return base;
  }

  // Bound target — at minimum record what the caller used. Useful because
  // the per-step success rate is the load-bearing finding here, not a new
  // resolver.
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (typeof args.ref === "string") {
    base.ref = args.ref;
    return base;
  }
  if (typeof args.selector === "string") {
    base.selectorHint = args.selector;
    return base;
  }
  if (typeof args.named === "string") {
    base.selectorHint = `named:${args.named}`;
    return base;
  }
  // No target info to cache — skip the step entirely so the artifact stays
  // signal-dense.
  return null;
}

function extractPlanDescriptor(result: unknown): CachedResolver["descriptor"] | null {
  if (!result || typeof result !== "object") return null;
  const r = result as PlanResultLike;
  const d = r.descriptor;
  if (!d || typeof d !== "object") return null;
  const ref = (d as { ref?: unknown }).ref;
  const verb = (d as { verb?: unknown }).verb;
  const args = (d as { args?: unknown }).args;
  if (typeof ref !== "string" || typeof verb !== "string") return null;
  const out: NonNullable<CachedResolver["descriptor"]> = {
    ref,
    verb: verb as ActionDescriptor["verb"],
    args: (args && typeof args === "object" ? args : {}) as ActionDescriptor["args"],
  };
  const ev = (d as { evidence?: unknown }).evidence;
  if (ev && typeof ev === "object") {
    const e = ev as Record<string, unknown>;
    const projected: NonNullable<NonNullable<CachedResolver["descriptor"]>["evidence"]> = {
      selectorHint: typeof e.selectorHint === "string" ? e.selectorHint : "",
      selectorTier: (typeof e.selectorTier === "number" ? e.selectorTier : 5) as PlanEvidence["selectorTier"],
      stability: (typeof e.stability === "string" ? e.stability : "low") as PlanEvidence["stability"],
      role: typeof e.role === "string" ? e.role : "",
    };
    if (typeof e.name === "string") projected.name = e.name;
    if (typeof e.testId === "string") projected.testId = e.testId;
    out.evidence = projected;
  }
  return out;
}

function extractFindTop(result: unknown): { ref: string; selectorHint: string } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as FindResultLike;
  if (!Array.isArray(r.candidates) || r.candidates.length === 0) return null;
  const top = r.candidates[0]!;
  if (typeof top.ref !== "string") return null;
  return {
    ref: top.ref,
    selectorHint: typeof top.selectorHint === "string" ? top.selectorHint : "",
  };
}
