// perf_audit type vocabulary — the audit category union, issue/remediation/
// result shapes, and the analyser context. Split out of perf-audit.ts so the
// analysers and the report composer share one type home without either file
// exceeding the size budget. Re-exported through `./perf-audit.js`.

import type { TraceEvent } from "./perf.js";
import type { JsCoverageEntry, CssCoverageEntry } from "./coverage.js";
import type { MemoryDiffResult } from "./memory-diff.js";

/** The eight initial audit categories. Order is meaningful — issues are
 *  surfaced in this order when severity ties. */
export type AuditCategory =
  | "render-blocking"
  | "unused-code"
  | "oversize-images"
  | "layout-thrashing"
  | "long-tasks"
  | "leak-suspects"
  | "cache-opportunities"
  | "font-loading";

export const ALL_AUDIT_CATEGORIES: AuditCategory[] = [
  "render-blocking",
  "unused-code",
  "oversize-images",
  "layout-thrashing",
  "long-tasks",
  "leak-suspects",
  "cache-opportunities",
  "font-loading",
];

export type IssueSeverity = "high" | "medium" | "low";

export interface AuditIssue {
  category: AuditCategory;
  severity: IssueSeverity;
  title: string;
  /** Free-form additional context, structured per category. */
  details?: Record<string, unknown>;
}

export interface AuditRemediation {
  category: AuditCategory;
  /** Imperative one-liner: "Defer non-critical CSS in <head>". */
  action: string;
  /** Optional URL pointing at the offending resource the remediation applies
   *  to (when the analyser identified a specific target). */
  target?: string;
}

export interface CategoryResult {
  issues: AuditIssue[];
  remediations: AuditRemediation[];
}

export interface AuditContext {
  trace: TraceEvent[];
  jsCoverage?: JsCoverageEntry[];
  cssCoverage?: CssCoverageEntry[];
  memoryDiff?: MemoryDiffResult;
  /** Network response metadata, when available, for cache-opportunities
   *  + oversize-images + font-loading categories. */
  responses?: Array<{
    url: string;
    status: number;
    mimeType?: string;
    encodedDataLength?: number;
    cacheControl?: string;
  }>;
}

export type AuditCategoryAnalyser = (ctx: AuditContext) => CategoryResult;
