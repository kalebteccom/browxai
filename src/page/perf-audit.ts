// perf_audit — capability `read`. The headline tool.
//
// Promotes browxai's perf surface from *measurement* (`perf_start/stop/insights`)
// to *actionable* — agents get a structured audit with remediation hints, not
// a raw 100MB trace blob.
//
// Internally pluggable: each category is an `AuditCategoryAnalyser` function
// in the registry below. Adding a category = adding a registry entry. The
// public MCP surface is unchanged.
//
// Output budget: `format:"summary"` (default) MUST stay under 2000 tokens.
// `truncateSummaryToBudget` drops the lowest-severity issues + records a
// warning when the cap binds. `format:"full"` is unbounded — the caller
// opts in.

import { estimateTokens } from "../util/tokens.js";
import { invariant } from "../util/invariant.js";
import {
  type IssueSeverity,
  type AuditIssue,
  type AuditRemediation,
  type AuditContext,
  type CategoryResult,
} from "./perf-audit-types.js";
import { ANALYSERS, ALL_AUDIT_CATEGORIES, type AuditCategory } from "./perf-audit-analysers.js";

// The audit type vocabulary lives in `perf-audit-types.ts`; the category
// analysers + the `ANALYSERS` registry (the single source of truth from which
// `AuditCategory` + `ALL_AUDIT_CATEGORIES` derive) in `perf-audit-analysers.ts`.
// Re-exported here so callers import the whole perf_audit surface from
// `./perf-audit.js`.
export type {
  IssueSeverity,
  AuditIssue,
  AuditRemediation,
  CategoryResult,
  AuditContext,
  AuditCategoryAnalyser,
} from "./perf-audit-types.js";
export {
  ANALYSERS,
  ALL_AUDIT_CATEGORIES,
  type AuditCategory,
  analyseRenderBlocking,
  analyseUnusedCode,
  analyseOversizeImages,
  analyseLayoutThrashing,
  analyseLongTasks,
  analyseLeakSuspects,
  analyseCacheOpportunities,
  analyseFontLoading,
} from "./perf-audit-analysers.js";

// ---------------------------------------------------------------------------
// Compose the final report
// ---------------------------------------------------------------------------

export interface AuditReport {
  summary: {
    score: number;
    topIssues: Array<{ category: AuditCategory; severity: IssueSeverity; title: string }>;
  };
  byCategory: Record<string, CategoryResult>;
  warnings: string[];
}

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = { high: 10, medium: 4, low: 1 };
export const SUMMARY_TOKEN_BUDGET = 2000;
const MAX_PER_CATEGORY_SUMMARY = 3;

// L7 (bounded everything) — the summary-budget trim is bounded on BOTH axes:
//
//   * Iteration: every trim loop drops at least one entry per iteration (or
//     breaks), so the total iteration count is bounded by the number of
//     droppable entries. `TRIM_ITERATION_CAP` is the explicit hard ceiling — a
//     belt-and-braces bound so a future estimator change can never turn the trim
//     into an unbounded `while`. The audit flagged the old `while (!withinBudget)`
//     as the one loop in the bounded inventory lacking an explicit cap.
//   * Size: even when the report cannot be trimmed under the soft 2000-token
//     budget (a single high-severity issue with a long title — or a ~1MB resource
//     URL stored in `details`/`target` — can exceed it alone), the RETURNED summary
//     never exceeds `SUMMARY_TOKEN_HARD_CEILING` (2.5× the soft budget). The trim
//     drops whole entries until at or under the ceiling, then `enforceHardCeiling`
//     GUARANTEES the ceiling BY CONSTRUCTION: it deep-truncates EVERY string-bearing
//     field (titles, remediation action/target, every string in `details`, warnings
//     — recursively) and, for the structural-floor case, drops content. The ceiling
//     is a guarantee, not a hope — a valid audit never refuses due to size.
export const SUMMARY_BUDGET_CEILING_FACTOR = 2.5;
export const SUMMARY_TOKEN_HARD_CEILING = Math.ceil(
  SUMMARY_TOKEN_BUDGET * SUMMARY_BUDGET_CEILING_FACTOR,
);
const TRIM_ITERATION_CAP = 10_000;

/** Compose an audit report from already-collected context. The category set
 *  is the categories the caller asked for (default = all). `format`
 *  controls whether each category's `issues`/`remediations` are capped at
 *  3 (summary mode) or unbounded (full mode). The summary itself (the
 *  short `summary.topIssues` list + score) always exists; in summary mode
 *  the per-category bodies are also capped.
 *
 *  Token-budget enforcement: when `format:"summary"`, the function checks
 *  estimated token count and drops lowest-severity issues + remediations
 *  until under 2000. If even after total trimming the body exceeds the
 *  cap, a `warnings[]` entry surfaces it. */
export function composeReport(
  ctx: AuditContext,
  categories: AuditCategory[],
  format: "summary" | "full",
): AuditReport {
  const byCategory: Record<string, CategoryResult> = {};
  const allIssues: AuditIssue[] = [];
  const warnings: string[] = [];
  for (const cat of categories) {
    const analyser = ANALYSERS[cat];
    if (!analyser) continue;
    try {
      const result = analyser(ctx);
      byCategory[cat] =
        format === "summary" ? capCategory(result, MAX_PER_CATEGORY_SUMMARY) : result;
      for (const i of result.issues) allIssues.push(i);
    } catch (err) {
      warnings.push(
        `Category ${cat} analyser threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      byCategory[cat] = { issues: [], remediations: [] };
    }
  }
  // Score: 100 - sum of severity-weighted issue counts, floored at 0.
  const penalty = allIssues.reduce((s, i) => s + SEVERITY_WEIGHT[i.severity], 0);
  const score = Math.max(0, 100 - penalty);
  const topIssues = pickTopIssues(allIssues);
  const report: AuditReport = {
    summary: { score, topIssues },
    byCategory,
    warnings,
  };
  if (format === "summary") {
    return enforceSummaryBudget(report);
  }
  return report;
}

function capCategory(r: CategoryResult, n: number): CategoryResult {
  // Cap by severity-weighted ordering — high first, then medium, then low.
  const sortedIssues = [...r.issues].sort(
    (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity],
  );
  const keptIssues = sortedIssues.slice(0, n);
  // Remediations don't have severity directly — keep the first N.
  const keptRems: AuditRemediation[] = [];
  for (const rem of r.remediations) {
    if (keptRems.length >= n) break;
    keptRems.push(rem);
  }
  return { issues: keptIssues, remediations: keptRems };
}

function pickTopIssues(
  all: AuditIssue[],
): Array<{ category: AuditCategory; severity: IssueSeverity; title: string }> {
  const sorted = [...all].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
  const top = sorted.slice(0, 10);
  return top.map((i) => ({ category: i.category, severity: i.severity, title: i.title }));
}

const SEVERITY_ORDER: IssueSeverity[] = ["low", "medium", "high"];

/** Returns true once the report is within budget. */
function withinBudget(report: AuditReport): boolean {
  return estimateTokens(JSON.stringify(report)) <= SUMMARY_TOKEN_BUDGET;
}

/** One severity pass — drop `sev` issues across categories + paired remediations
 *  + matching topIssues until within budget. Returns the count dropped. */
function dropSeverityPass(report: AuditReport, sev: IssueSeverity): number {
  let dropped = 0;
  for (const cat of Object.keys(report.byCategory)) {
    const r = report.byCategory[cat]!;
    const newIssues: AuditIssue[] = [];
    for (const i of r.issues) {
      if (i.severity === sev && !withinBudget(report)) {
        dropped++;
        continue;
      }
      newIssues.push(i);
    }
    r.issues = newIssues;
    if (r.remediations.length > r.issues.length) {
      r.remediations = r.remediations.slice(0, Math.max(1, r.issues.length));
    }
    if (withinBudget(report)) break;
  }
  // The summary's cross-category topIssues list can dominate the budget alone.
  if (!withinBudget(report)) {
    const before = report.summary.topIssues.length;
    report.summary.topIssues = report.summary.topIssues.filter((t) => t.severity !== sev);
    dropped += before - report.summary.topIssues.length;
  }
  return dropped;
}

/** Final aggressive trim — pop topIssues then per-category issues until within
 *  budget or nothing left to drop. Returns the count dropped.
 *
 *  L7: bounded by `TRIM_ITERATION_CAP`. Every iteration of the second loop drops
 *  at least one entry (or sets `trimmed = false` and breaks), so it terminates in
 *  at most (total issues across categories) iterations — the explicit cap is the
 *  hard ceiling that makes termination a property the code GUARANTEES rather than
 *  relies on the `trimmed` flag for. A `termination` invariant fires if the cap is
 *  ever hit (it cannot be on any real report; the bounded-resource property test
 *  exercises an adversarial report to prove it). */
function trimAggressively(report: AuditReport): number {
  let dropped = 0;
  // cap: at most `TRIM_ITERATION_CAP` pops — each removes one topIssue.
  let iterations = 0;
  while (report.summary.topIssues.length > 1 && !withinBudget(report)) {
    invariant(
      iterations++ < TRIM_ITERATION_CAP,
      "perf-audit topIssues trim exceeded iteration cap",
    );
    report.summary.topIssues.pop();
    dropped++;
  }
  // cap: at most `TRIM_ITERATION_CAP` passes — each pass that does not break drops
  // at least one per-category issue, so the loop is bounded by the entry count.
  iterations = 0;
  while (!withinBudget(report)) {
    invariant(
      iterations++ < TRIM_ITERATION_CAP,
      "perf-audit per-category trim exceeded iteration cap",
    );
    let trimmed = false;
    for (const cat of Object.keys(report.byCategory)) {
      const r = report.byCategory[cat]!;
      if (r.issues.length > 0) {
        r.issues.pop();
        if (r.remediations.length > r.issues.length) r.remediations.pop();
        dropped++;
        trimmed = true;
        if (withinBudget(report)) break;
      }
    }
    if (!trimmed) break;
  }
  return dropped;
}

/** A mutable handle on one string-bearing field anywhere in the report. */
interface StringRef {
  get: () => string;
  set: (s: string) => void;
}

const TRUNCATION_NOTE = "summary truncated to honour the hard token ceiling.";

/** Collect a mutable handle on EVERY human-readable / data string in the report —
 *  topIssue titles; per-category issue titles + every string value in their
 *  `details` (recursively, where a ~1MB resource URL can hide); remediation
 *  `action` + `target`; and the warnings. This is the exhaustive set the hard
 *  ceiling truncates, so no string-bearing field can keep the report over the
 *  ceiling. */
function collectStringRefs(report: AuditReport): StringRef[] {
  const refs: StringRef[] = [];
  for (let i = 0; i < report.summary.topIssues.length; i++) {
    refs.push({
      get: () => report.summary.topIssues[i]!.title,
      set: (s) => (report.summary.topIssues[i]!.title = s),
    });
  }
  for (const cat of Object.keys(report.byCategory)) {
    const r = report.byCategory[cat]!;
    for (let i = 0; i < r.issues.length; i++) {
      refs.push({
        get: () => r.issues[i]!.title,
        set: (s) => (r.issues[i]!.title = s),
      });
      collectRecordStringRefs(r.issues[i]!.details, refs);
    }
    for (let i = 0; i < r.remediations.length; i++) {
      const rem = r.remediations[i]!;
      refs.push({ get: () => rem.action, set: (s) => (rem.action = s) });
      if (typeof rem.target === "string") {
        refs.push({ get: () => rem.target as string, set: (s) => (rem.target = s) });
      }
    }
  }
  for (let i = 0; i < report.warnings.length; i++) {
    refs.push({
      get: () => report.warnings[i]!,
      set: (s) => (report.warnings[i] = s),
    });
  }
  return refs;
}

/** Recursively gather string-valued fields in a free-form `details` record (and
 *  nested records/arrays) so a long URL or message inside `details` is reachable
 *  by the truncator — `details` is `Record<string, unknown>`, so a string field
 *  can hide at any depth. Bounded by the (finite) structure of the value. */
function collectRecordStringRefs(value: unknown, refs: StringRef[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const arr = value;
      if (typeof arr[i] === "string") {
        refs.push({ get: () => arr[i] as string, set: (s) => (arr[i] = s) });
      } else {
        collectRecordStringRefs(arr[i], refs);
      }
    }
    return;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (typeof rec[key] === "string") {
        refs.push({ get: () => rec[key] as string, set: (s) => (rec[key] = s) });
      } else {
        collectRecordStringRefs(rec[key], refs);
      }
    }
  }
}

/** L7 hard-ceiling enforcement — the last line of defence, GUARANTEED BY
 *  CONSTRUCTION. The returned report is ALWAYS ≤ `SUMMARY_TOKEN_HARD_CEILING`:
 *
 *  1. Deep-truncate every string-bearing field (titles, remediation
 *     action/target, every string in `details`, warnings — recursively), halving
 *     the longest each pass until the estimate is within the ceiling. A single
 *     irreducible long entry (e.g. a ~1MB resource URL stored in `details`/`target`)
 *     is shrunk here, not refused.
 *  2. If after every string is driven to its 1-char floor the report is STILL
 *     over (the structural-floor case — thousands of warnings / issues whose KEYS
 *     and numbers alone exceed the ceiling), drop structural content (warnings,
 *     then per-category issues + remediations, then topIssues) until within the
 *     ceiling, appending one short truncation note.
 *
 *  The ceiling is therefore a post-condition established by construction — a valid
 *  audit NEVER refuses due to size. The TERMINATION cap below is the real L7
 *  protection (it asserts the bounded loop terminates); the ceiling post-condition
 *  is kept as a defensive sanity but is unreachable. */
function enforceHardCeiling(report: AuditReport): void {
  // Phase 1 — halve the longest string until within the ceiling or nothing left
  // to shorten. cap: each pass at least halves the single longest string, so the
  // string mass shrinks geometrically; bounded by `TRIM_ITERATION_CAP`.
  let iterations = 0;
  while (estimateTokens(JSON.stringify(report)) > SUMMARY_TOKEN_HARD_CEILING) {
    invariant(
      iterations++ < TRIM_ITERATION_CAP,
      "perf-audit hard-ceiling string-truncation exceeded iteration cap",
    );
    if (!shortenLongestString(report)) break; // every string at its 1-char floor
  }
  // Phase 2 — structural floor: strings are minimized but the skeleton (keys +
  // numbers across thousands of entries) still exceeds the ceiling. Drop content
  // until within it, then note the truncation once. cap: each pass drops at least
  // one structural element (or breaks), so it is bounded by the entry count.
  iterations = 0;
  let noted = false;
  while (estimateTokens(JSON.stringify(report)) > SUMMARY_TOKEN_HARD_CEILING) {
    invariant(
      iterations++ < TRIM_ITERATION_CAP,
      "perf-audit hard-ceiling structural-drop exceeded iteration cap",
    );
    if (!noted) {
      report.warnings = [TRUNCATION_NOTE];
      noted = true;
    }
    if (!dropStructuralContent(report)) break; // nothing structural left to drop
  }
  // Defensive post-condition — unreachable: phase 2 drives the report to an empty
  // skeleton (far under the ceiling) if phase 1 could not. Kept as a sanity guard.
  invariant(
    estimateTokens(JSON.stringify(report)) <= SUMMARY_TOKEN_HARD_CEILING,
    `perf-audit summary exceeded hard ceiling (${SUMMARY_TOKEN_HARD_CEILING} tokens)`,
  );
}

/** Halve the single longest string anywhere in the report. Returns false when no
 *  string is longer than its 1-char floor — i.e. nothing left to shorten. */
function shortenLongestString(report: AuditReport): boolean {
  let longest: { ref: StringRef; len: number } | null = null;
  for (const ref of collectStringRefs(report)) {
    const len = ref.get().length;
    if (len > 1 && (!longest || len > longest.len)) longest = { ref, len };
  }
  if (!longest) return false;
  const cur = longest.ref.get();
  longest.ref.set(cur.slice(0, Math.max(1, Math.floor(cur.length / 2))) + "…");
  return true;
}

/** Drop one unit of structural content for the structural-floor case — warnings
 *  beyond the note first, then per-category issues + their paired remediations,
 *  then topIssues. Returns false when only the empty skeleton remains. */
function dropStructuralContent(report: AuditReport): boolean {
  if (report.warnings.length > 1) {
    report.warnings = report.warnings.slice(0, 1);
    return true;
  }
  for (const cat of Object.keys(report.byCategory)) {
    const r = report.byCategory[cat]!;
    if (r.issues.length > 0) {
      r.issues.pop();
      if (r.remediations.length > 0) r.remediations.pop();
      return true;
    }
    if (r.remediations.length > 0) {
      r.remediations.pop();
      return true;
    }
  }
  if (report.summary.topIssues.length > 0) {
    report.summary.topIssues.pop();
    return true;
  }
  return false;
}

/** Drop lowest-severity issues across all categories until estimated tokens
 *  are within the summary budget. Adds a warnings[] entry if the cap binds. */
export function enforceSummaryBudget(report: AuditReport): AuditReport {
  if (withinBudget(report)) return report;
  let dropped = 0;
  for (const sev of SEVERITY_ORDER) {
    if (withinBudget(report)) break;
    dropped += dropSeverityPass(report, sev);
  }
  dropped += trimAggressively(report);
  if (dropped > 0) {
    report.warnings.push(
      `summary token budget enforced (${SUMMARY_TOKEN_BUDGET}): dropped ${dropped} low/medium severity entries. Re-run with format:"full" for the full report.`,
    );
  }
  // L7: the soft trim above drops WHOLE entries; a single irreducible large entry
  // (e.g. a ~1MB resource URL in `details`/`target`) can still exceed the budget.
  // `enforceHardCeiling` GUARANTEES BY CONSTRUCTION that the RETURNED report is
  // within the hard ceiling — it deep-truncates every string-bearing field and,
  // for the structural-floor case, drops content — so a valid audit NEVER refuses
  // due to size. Always run it last, even when the soft trim already fit, so the
  // hard ceiling is an unconditional postcondition.
  enforceHardCeiling(report);
  return report;
}

/** Resolve the requested category set — empty/undefined → all. Unknown
 *  category names are dropped silently. */
export function resolveCategories(requested?: string[]): AuditCategory[] {
  if (!requested || requested.length === 0) return [...ALL_AUDIT_CATEGORIES];
  const out: AuditCategory[] = [];
  for (const c of requested) {
    if (ALL_AUDIT_CATEGORIES.includes(c as AuditCategory)) out.push(c as AuditCategory);
  }
  if (out.length === 0) return [...ALL_AUDIT_CATEGORIES];
  return out;
}
