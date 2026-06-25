/// <reference lib="dom" />
// `overflow_detect` — diagnose page-layout overflow.
//
// The silent UI-breakage primitive: clipped buttons, ellipsis-truncated
// labels, horizontal-scrollbar-on-mobile bugs. Agents repeatedly miss
// these because a screenshot looks "fine" (the clipped pixel doesn't
// shout) and `find()` doesn't surface "the element rendered but its
// content was lost". This tool walks the DOM, applies four overflow
// shape detectors, and returns one finding per offending element.
//
// COHESION split — this file is now the engine-bound orchestrator:
//
//   - overflow-detect-types.ts — the engine-blind DOMAIN: detector
//     taxonomy types, finding/evidence shapes, the EPSILON math, the
//     pure selector-synthesis + limit + type-resolution helpers.
//   - overflow-detect-page.ts  — `PAGE_DETECT_FN`, the in-page (CDP-
//     serialized) detector function literal.
//
// This module keeps the `detectOverflow` handler + the Page-shaped adapter,
// and re-exports the domain surface so importers + colocated tests keep
// their `./overflow-detect.js` import path.
//
// Page-side function is passed as a REAL function literal (not a
// stringified arrow) so Playwright's `Page.evaluate(fn, arg)` path
// serializes the source and invokes in-page with the arg. The same trap
// burned `dom_export`'s `PAGE_WALK_FN` and `element_export`'s discovery
// function — a stringified `(args) => {...}` evaluates to the function
// value uncalled, which CDP can't serialize → undefined.

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_ELEMENTS_SCANNED,
  OVERFLOW_EPSILON,
  SELECTOR_MAX_LEN,
  applyLimit,
  resolveTypes,
  type OverflowScope,
  type OverflowDetectArgs,
  type OverflowDetectResult,
  type OverflowFinding,
} from "./overflow-detect-types.js";
import { PAGE_DETECT_FN } from "./overflow-detect-page.js";

// Re-export the domain surface so importers + colocated tests keep their
// `./overflow-detect.js` import path unchanged.
export {
  ALL_TYPES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_ELEMENTS_SCANNED,
  OVERFLOW_EPSILON,
  SELECTOR_MAX_LEN,
  synthesiseSelector,
  applyLimit,
  resolveTypes,
  overflows,
} from "./overflow-detect-types.js";
export type {
  OverflowType,
  OverflowScope,
  OverflowDetectArgs,
  OverflowBbox,
  OverflowEvidence,
  OverflowFinding,
  OverflowDetectResult,
  SelectorSynth,
  MinimalElement,
  PageRawFinding,
  PageRawResult,
} from "./overflow-detect-types.js";

/** Thin Page-shaped adapter so the unit tests can stub the page surface.
 *  Mirrors the patterns in `dom_export` / `element_export`. `evaluate`
 *  takes a real function (Playwright serializes it + invokes in-page) —
 *  passing a stringified arrow returns the function uncalled. */
export interface OverflowDetectPage {
  evaluate<T, Arg>(fn: (arg: Arg) => T | Promise<T>, args?: Arg): Promise<T>;
}

export async function detectOverflow(
  page: OverflowDetectPage,
  args: OverflowDetectArgs = {},
): Promise<OverflowDetectResult> {
  const scope: OverflowScope = args.scope ?? "document";
  const typeSet = resolveTypes(args.types);
  const rawLimit = args.limit ?? DEFAULT_LIMIT;
  if (!(rawLimit > 0)) {
    throw new Error(`overflow_detect: limit must be > 0 — got ${rawLimit}.`);
  }
  const limit = Math.min(rawLimit, MAX_LIMIT);

  const raw = await page.evaluate(PAGE_DETECT_FN, {
    types: Array.from(typeSet),
    scope,
    maxElements: MAX_ELEMENTS_SCANNED,
    epsilon: OVERFLOW_EPSILON,
    selectorMaxLen: SELECTOR_MAX_LEN,
  });

  const findings: OverflowFinding[] = [];
  for (const rf of raw.findings) {
    // If selector was truncated, fold the original-length note into
    // evidence — the agent shouldn't have to guess why the selector is
    // a bare tag.
    if (rf.selectorTruncated) {
      findings.push({
        selector: rf.selector,
        bbox: rf.bbox,
        type: rf.type,
        evidence: {
          selectorTruncated: true,
          originalLength: rf.selectorOriginalLength,
        },
      });
    } else {
      findings.push({
        selector: rf.selector,
        bbox: rf.bbox,
        type: rf.type,
        evidence: rf.evidence,
      });
    }
  }

  const { kept, truncated } = applyLimit(findings, limit);
  const warnings: string[] = [];
  if (raw.scanCapped) {
    warnings.push(
      `scan stopped at MAX_ELEMENTS_SCANNED (${MAX_ELEMENTS_SCANNED}) — re-run with scope:viewport for a narrower pass`,
    );
  }

  return {
    ok: true,
    scope,
    findings: kept,
    truncated,
    warnings,
  };
}
