// L7 (bounded everything) — the bounded-resource budget tests. RFC 0004 P5 / 02
// §4.2. Each test EXHIBITS a named bound rather than reading the constant and
// asserting it equals itself (a tautology a refactor would update in lockstep):
// it drives the resource past its cap and asserts the contained behaviour, so
// removing the guard fails the test for the right reason (the "exhibit the bound"
// discipline, 02 §4.2). These are `error`-level — the budget tests promote with
// the phase; the bounded-resource LINT rule stays advisory `warn` (it is a
// halting-problem heuristic, 0004-05 §1.3).
//
// The two gaps the audit named are the headline cases:
//   * perf-audit `enforceSummaryBudget` — the one loop in the bounded inventory
//     that lacked an explicit iteration cap; now bounded + a hard 2.5× size
//     ceiling. Exercised on an ADVERSARIAL report (termination + the ceiling).
//   * the a11y tree-walk depth — iterative but with no declared depth cap; now
//     `MAX_WALK_DEPTH`. Exercised with a tree deeper than the cap.
// The network ring (already capped at 500) is pinned too, so a refactor that
// dropped its eviction is caught here.

import { describe, it, expect } from "vitest";
import {
  composeReport,
  enforceSummaryBudget,
  SUMMARY_TOKEN_HARD_CEILING,
  type AuditReport,
  type AuditContext,
} from "../../src/page/perf-audit.js";
import { estimateTokens } from "../../src/util/tokens.js";
import { walk, MAX_WALK_DEPTH, type A11yNode } from "../../src/page/a11y.js";
import { NetworkBuffer } from "../../src/page/network.js";

// ── perf-audit token budget — termination + the ≤ 2.5× ceiling ───────────────

/** Build an adversarial summary report: many high-severity issues with long
 *  titles across every category, so the soft 2000-token budget is blown by a wide
 *  margin and the trim loops + the hard-ceiling truncation are forced to run to
 *  the end. High severity means the low/medium severity passes can't trim it —
 *  only the aggressive trim + the hard ceiling can. */
function adversarialReport(issuesPerCategory: number, titleLen: number): AuditReport {
  const longTitle = "X".repeat(titleLen);
  const categories = [
    "render-blocking",
    "unused-code",
    "oversize-images",
    "layout-thrashing",
    "long-tasks",
    "leak-suspects",
    "cache-opportunities",
    "font-loading",
  ] as const;
  const byCategory: AuditReport["byCategory"] = {};
  const topIssues: AuditReport["summary"]["topIssues"] = [];
  for (const cat of categories) {
    const issues = Array.from({ length: issuesPerCategory }, (_, i) => ({
      category: cat,
      severity: "high" as const,
      title: `${longTitle}-${cat}-${i}`,
    }));
    byCategory[cat] = {
      issues,
      remediations: issues.map((_, i) => ({ category: cat, action: `${longTitle}-fix-${i}` })),
    };
    for (const iss of issues) {
      topIssues.push({ category: iss.category, severity: iss.severity, title: iss.title });
    }
  }
  return { summary: { score: 0, topIssues }, byCategory, warnings: [] };
}

describe("L7 — perf-audit summary budget terminates and stays under the 2.5× ceiling", () => {
  it("terminates and returns ≤ 2.5× the soft budget on an adversarial report", () => {
    const report = adversarialReport(50, 400);
    // Pre-condition: the report genuinely blows the soft budget by a wide margin,
    // so the trim machinery is forced to run (not a no-op path).
    expect(estimateTokens(JSON.stringify(report))).toBeGreaterThan(SUMMARY_TOKEN_HARD_CEILING * 4);

    const out = enforceSummaryBudget(report);

    // Termination is exhibited by the call RETURNING at all (an unbounded loop
    // would hang the test). The size bound is the explicit guarantee: the
    // returned report is at or under the hard ceiling.
    expect(estimateTokens(JSON.stringify(out))).toBeLessThanOrEqual(SUMMARY_TOKEN_HARD_CEILING);
  });

  it("holds the ceiling even with a single irreducible huge entry", () => {
    // One high-severity issue whose title alone dwarfs the ceiling — whole-entry
    // trimming cannot shrink it (popping it would empty the report), so only the
    // hard-ceiling string truncation can. Proves the ceiling is a guarantee, not
    // an artefact of having many small entries to drop.
    const huge = "Y".repeat(SUMMARY_TOKEN_HARD_CEILING * 8);
    const report: AuditReport = {
      summary: {
        score: 0,
        topIssues: [{ category: "long-tasks", severity: "high", title: huge }],
      },
      byCategory: {
        "long-tasks": {
          issues: [{ category: "long-tasks", severity: "high", title: huge }],
          remediations: [{ category: "long-tasks", action: huge }],
        },
      },
      warnings: [],
    };
    const out = enforceSummaryBudget(report);
    expect(estimateTokens(JSON.stringify(out))).toBeLessThanOrEqual(SUMMARY_TOKEN_HARD_CEILING);
  });

  it("is a no-op (preserves the report) when already within budget", () => {
    // The bound must not perturb a small report — behaviour-preservation on the
    // common path.
    const report: AuditReport = {
      summary: { score: 90, topIssues: [{ category: "long-tasks", severity: "low", title: "ok" }] },
      byCategory: { "long-tasks": { issues: [], remediations: [] } },
      warnings: [],
    };
    const before = JSON.stringify(report);
    const out = enforceSummaryBudget(report);
    expect(JSON.stringify(out)).toBe(before);
  });

  it("the real composeReport path stays under the hard ceiling on an empty context", () => {
    // End-to-end: a real summary compose must already honour the ceiling.
    const ctx = { trace: [], coverage: [], resources: [] } as unknown as AuditContext;
    const report = composeReport(
      ctx,
      ["long-tasks", "render-blocking", "unused-code"] as never,
      "summary",
    );
    expect(estimateTokens(JSON.stringify(report))).toBeLessThanOrEqual(SUMMARY_TOKEN_HARD_CEILING);
  });

  it("returns a bounded report (never refuses) on a VALID audit with a ~1MB URL", () => {
    // Regression: a JS resource with a ~1MB-long URL (reachable via data: URIs /
    // long query strings) stores that URL in the issue's `details.url` AND the
    // remediation's `target`. The pre-fix `enforceHardCeiling` truncated only
    // titles/actions/warnings — not `details`/`target` — so a remediation the trim
    // KEEPS held the megabyte string and the report stayed over the hard ceiling,
    // firing the post-condition invariant and converting a VALID summary audit into
    // a browxai-internal refusal. The fix deep-truncates every string-bearing field
    // (incl. `details` recursively + `target`), so the ceiling is guaranteed by
    // construction: the audit returns a bounded report, it does NOT throw.
    const megaUrl = "https://example.test/app.js?" + "x".repeat(1024 * 1024);
    const ctx = {
      trace: [],
      jsCoverage: [{ url: megaUrl, totalBytes: 200000, usedBytes: 1000, usagePercent: 0.5 }],
    } as unknown as AuditContext;

    let report: AuditReport | undefined;
    expect(() => {
      report = composeReport(ctx, ["unused-code"] as never, "summary");
    }).not.toThrow();
    expect(report).toBeDefined();
    expect(estimateTokens(JSON.stringify(report))).toBeLessThanOrEqual(SUMMARY_TOKEN_HARD_CEILING);
  });
});

// ── a11y tree-walk depth cap ─────────────────────────────────────────────────

/** A linear chain of `depth` nested single-child nodes — the pathological tree
 *  the cap contains. */
function deepChain(depth: number): A11yNode {
  const root: A11yNode = { ref: "n0", role: "root", children: [] };
  let cur = root;
  for (let i = 1; i <= depth; i++) {
    const child: A11yNode = { ref: `n${i}`, role: "generic", children: [] };
    cur.children.push(child);
    cur = child;
  }
  return root;
}

describe("L7 — a11y walk() is depth-bounded", () => {
  it("never yields a node deeper than MAX_WALK_DEPTH on a pathological tree", () => {
    // Build a chain deeper than the cap; the walk must truncate, not exhaust.
    const root = deepChain(MAX_WALK_DEPTH + 500);
    let maxDepthSeen = 0;
    let count = 0;
    for (const { depth } of walk(root)) {
      maxDepthSeen = Math.max(maxDepthSeen, depth);
      count++;
      // Guard the test itself against a regression that removed the cap.
      if (count > MAX_WALK_DEPTH * 4) break;
    }
    expect(maxDepthSeen).toBeLessThanOrEqual(MAX_WALK_DEPTH);
    // Truncated at the cap (+1 for the root at depth 0), never the full chain.
    expect(count).toBeLessThanOrEqual(MAX_WALK_DEPTH + 1);
  });

  it("walks a normal-depth tree in full (the cap never trips in practice)", () => {
    const root = deepChain(40); // a deep SPA is rarely past this
    const depths = [...walk(root)].map((x) => x.depth);
    expect(Math.max(...depths)).toBe(40);
    expect(depths.length).toBe(41); // root + 40 descendants, none truncated
  });
});

// ── network ring buffer cap ──────────────────────────────────────────────────

describe("L7 — NetworkBuffer ring is capped", () => {
  it("rejects a non-positive cap (the bound must be meaningful)", () => {
    expect(() => new NetworkBuffer(undefined, 0)).toThrow(/invariant violated/i);
    expect(() => new NetworkBuffer(undefined, -1)).toThrow(/invariant violated/i);
  });

  it("retains at most `cap` entries when pushed past the bound", () => {
    // `push` is private; exercise it through the public `recent()` read after
    // driving more synthetic entries than the cap via the test-only seam.
    const cap = 8;
    const buf = new NetworkBuffer(undefined, cap);
    // pushEntryForTest is exposed only for this bounded-resource assertion.
    const anyBuf = buf as unknown as {
      push(e: { method: string; url: string; type: string }): void;
    };
    for (let i = 0; i < cap + 20; i++) {
      anyBuf.push({ method: "GET", url: `https://x/${i}`, type: "Other" });
    }
    const ringLen = (buf as unknown as { ring: unknown[] }).ring.length;
    expect(ringLen).toBe(cap);
  });
});
