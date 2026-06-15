// perf_audit type vocabulary — the audit category union, issue/remediation/
// result shapes, and the analyser context. Split out of perf-audit.ts so the
// analysers and the report composer share one type home without either file
// exceeding the size budget. Re-exported through `./perf-audit.js`.

import type { TraceEvent } from "./perf.js";
import type { JsCoverageEntry, CssCoverageEntry } from "./coverage.js";
import type { MemoryDiffResult } from "./memory-diff.js";
// RFC 0004 P4 / D6 — `AuditCategory` is DERIVED from the `ANALYSERS` registry
// (the single source of truth) in `perf-audit-analysers.ts`. This is a TYPE-ONLY
// import: the value side of that module (the `ANALYSERS` object + analyser fns)
// imports the issue/result shapes from here, so a runtime re-export of the union
// would be a cycle. Importing only the type keeps the edge type-only (erased at
// compile) — the category vocabulary still has exactly one declaration site.
import type { AuditCategory } from "./perf-audit-analysers.js";

export type { AuditCategory } from "./perf-audit-analysers.js";

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
