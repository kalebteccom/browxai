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
import {
  type IssueSeverity,
  type AuditIssue,
  type AuditRemediation,
  type AuditContext,
  type CategoryResult,
} from "./perf-audit-types.js";
import {
  ANALYSERS,
  ALL_AUDIT_CATEGORIES,
  type AuditCategory,
} from "./perf-audit-analysers.js";

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
const SUMMARY_TOKEN_BUDGET = 2000;
const MAX_PER_CATEGORY_SUMMARY = 3;

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
 *  budget or nothing left to drop. Returns the count dropped. */
function trimAggressively(report: AuditReport): number {
  let dropped = 0;
  while (report.summary.topIssues.length > 1 && !withinBudget(report)) {
    report.summary.topIssues.pop();
    dropped++;
  }
  while (!withinBudget(report)) {
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

