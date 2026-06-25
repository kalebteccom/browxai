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
// Output budget: `format:"summary"` (default) MUST stay under 2000 tokens. The
// token-budget + hard-ceiling enforcement machinery (`enforceSummaryBudget` +
// the `SUMMARY_*` constants) lives in `perf-audit-budget.ts`; this file keeps
// the report composer + scoring and calls `enforceSummaryBudget` for summaries.
// `format:"full"` is unbounded — the caller opts in.

import {
  type IssueSeverity,
  type AuditIssue,
  type AuditRemediation,
  type AuditContext,
  type CategoryResult,
} from "./perf-audit-types.js";
import { ANALYSERS, ALL_AUDIT_CATEGORIES, type AuditCategory } from "./perf-audit-analysers.js";
import { enforceSummaryBudget } from "./perf-audit-budget.js";

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

// The summary token-budget + hard-ceiling machinery lives in
// `perf-audit-budget.ts`. Re-exported here so callers (and the bounded-resource
// fitness test) import the whole perf_audit surface from `./perf-audit.js`.
export {
  enforceSummaryBudget,
  SUMMARY_TOKEN_BUDGET,
  SUMMARY_BUDGET_CEILING_FACTOR,
  SUMMARY_TOKEN_HARD_CEILING,
} from "./perf-audit-budget.js";

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
