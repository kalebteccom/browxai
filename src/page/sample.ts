// bounded frame-aligned metric sampler.
//
// Jank / CLS / scroll-drift QA needs "sample this DOM metric every animation
// frame for N ms and return the series". The metric is a **fixed enum** — the
// agent supplies NO JavaScript (that would re-open the loophole closes;
// arbitrary JS stays `eval_js`, gated behind the `eval` capability). browxai
// supplies the fixed in-page rAF / interval loop.

import type { Locator, Page } from "playwright-core";
import { locatorFor, type ActionTarget } from "./locator.js";
import type { RefRegistry } from "./refs.js";

export const ELEMENT_METRICS = [
  "scrollTop",
  "scrollLeft",
  "scrollHeight",
  "scrollWidth",
  "clientWidth",
  "clientHeight",
  "bboxX",
  "bboxY",
  "bboxWidth",
  "bboxHeight",
] as const;
export type Metric = (typeof ELEMENT_METRICS)[number];

const BBOX_METRICS = new Set<Metric>(["bboxX", "bboxY", "bboxWidth", "bboxHeight"]);
const MAX_DURATION_MS = 30_000;
const MAX_SERIES = 2000;
/** Above this collected-point count, an unset `summary` auto-omits the full
 *  series (a raf window of a few seconds is hundreds of points; the agent
 *  almost always wants only the reduced signal, and the raw series balloons
 *  the tool-result token cost). Explicit `summary:false` opts back in. */
export const AUTO_SUMMARY_THRESHOLD = 300;

/** Tri-state series-omission policy (pure, unit-tested):
 *   - `summary === true`  → always omit the series (caller asked for reduced).
 *   - `summary === false` → always include it (caller opted into the raw set).
 *   - `summary` unset     → auto-omit only when the series is large. */
export function shouldOmitSeries(summary: boolean | undefined, count: number): boolean {
  if (summary === true) return true;
  if (summary === false) return false;
  return count > AUTO_SUMMARY_THRESHOLD;
}

export interface SampleArgs {
  target?: ActionTarget;
  metric: Metric;
  durationMs: number;
  everyFrame?: boolean;
  intervalMs?: number;
  /** Series-omission control (the `summary` is *always* returned regardless).
   *  `true` → omit the full `series`; `false` → always include it; unset →
   *  auto-omit only for large windows (> AUTO_SUMMARY_THRESHOLD points), with
   *  `autoSummarised: true` on the result. Pure server-side reduction of the
   *  already-collected fixed-metric series — no agent JS, no eval surface. */
  summary?: boolean;
}

export interface SampleSummary {
  count: number;
  min: number;
  max: number;
  first: number;
  last: number;
  /** Distinct sampled values (catches "did it move at all?"). */
  distinctCount: number;
  /** tMs of the first sample whose value differed from `first`; null if flat. */
  firstChangeTMs: number | null;
}

export interface SampleResult {
  metric: Metric;
  scope: "element" | "window";
  durationMs: number;
  mode: "raf" | "interval";
  intervalMs?: number;
  count: number;
  /** Present unless `summary` was requested. */
  series?: Array<{ tMs: number; value: number }>;
  /** Always present (cheap) — the reduced signal. */
  summary?: SampleSummary;
  /** true when the series was dropped by the auto-large-window policy (caller
   *  didn't set `summary`). Re-request with `summary:false` for the raw set. */
  autoSummarised?: boolean;
  truncated?: boolean;
}

/** Pure reduction of a collected series. Exported for unit tests. */
export function summariseSeries(series: Array<{ tMs: number; value: number }>): SampleSummary {
  if (series.length === 0) {
    return {
      count: 0,
      min: NaN,
      max: NaN,
      first: NaN,
      last: NaN,
      distinctCount: 0,
      firstChangeTMs: null,
    };
  }
  const first = series[0]!.value;
  let min = first;
  let max = first;
  let firstChangeTMs: number | null = null;
  const distinct = new Set<number>();
  for (const p of series) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
    distinct.add(p.value);
    if (firstChangeTMs === null && p.value !== first) firstChangeTMs = p.tMs;
  }
  return {
    count: series.length,
    min,
    max,
    first,
    last: series[series.length - 1]!.value,
    distinctCount: distinct.size,
    firstChangeTMs,
  };
}

type SamplerParams = {
  metric: string;
  durationMs: number;
  everyFrame: boolean;
  intervalMs: number;
  maxSeries: number;
};

// Both samplers are self-contained (no closure / outer refs) so Playwright can
// stringify and run them in-page. They differ only in arg shape:
//   loc.evaluate(fn, arg)  → fn(element, arg)
//   page.evaluate(fn, arg) → fn(arg)
// The metric/loop logic is intentionally duplicated rather than shared via a
// closure (which wouldn't survive serialization).

/** Element sampler — runs as `loc.evaluate(elementSampler, params)`. */
function elementSampler(
  el: HTMLElement,
  p: SamplerParams,
): Promise<Array<{ tMs: number; value: number }>> {
  const read = (): number => {
    switch (p.metric) {
      case "scrollTop":
        return el.scrollTop;
      case "scrollLeft":
        return el.scrollLeft;
      case "scrollHeight":
        return el.scrollHeight;
      case "scrollWidth":
        return el.scrollWidth;
      case "clientWidth":
        return el.clientWidth;
      case "clientHeight":
        return el.clientHeight;
      default: {
        const r = el.getBoundingClientRect();
        return p.metric === "bboxX"
          ? r.x
          : p.metric === "bboxY"
            ? r.y
            : p.metric === "bboxWidth"
              ? r.width
              : r.height;
      }
    }
  };
  return new Promise((resolve) => {
    const series: Array<{ tMs: number; value: number }> = [];
    const clock = () =>
      globalThis.performance && globalThis.performance.now
        ? globalThis.performance.now()
        : Date.now();
    const t0 = clock();
    const tick = () => {
      if (series.length < p.maxSeries)
        series.push({ tMs: Math.round(clock() - t0), value: read() });
      if (clock() - t0 >= p.durationMs || series.length >= p.maxSeries) {
        resolve(series);
        return;
      }
      if (p.everyFrame && globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(tick);
      else globalThis.setTimeout(tick, p.intervalMs);
    };
    tick();
  });
}

/** Window/document sampler — runs as `page.evaluate(windowSampler, params)`. */
function windowSampler(p: SamplerParams): Promise<Array<{ tMs: number; value: number }>> {
  const read = (): number => {
    const s = globalThis.document.scrollingElement || globalThis.document.documentElement;
    switch (p.metric) {
      case "scrollTop":
        return globalThis.scrollY ?? s.scrollTop ?? 0;
      case "scrollLeft":
        return globalThis.scrollX ?? s.scrollLeft ?? 0;
      case "scrollHeight":
        return s.scrollHeight;
      case "scrollWidth":
        return s.scrollWidth;
      case "clientWidth":
        return s.clientWidth;
      case "clientHeight":
        return s.clientHeight;
      default:
        return NaN; // bbox* rejected before we get here
    }
  };
  return new Promise((resolve) => {
    const series: Array<{ tMs: number; value: number }> = [];
    const clock = () =>
      globalThis.performance && globalThis.performance.now
        ? globalThis.performance.now()
        : Date.now();
    const t0 = clock();
    const tick = () => {
      if (series.length < p.maxSeries)
        series.push({ tMs: Math.round(clock() - t0), value: read() });
      if (clock() - t0 >= p.durationMs || series.length >= p.maxSeries) {
        resolve(series);
        return;
      }
      if (p.everyFrame && globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(tick);
      else globalThis.setTimeout(tick, p.intervalMs);
    };
    tick();
  });
}

export async function sampleMetric(
  page: Page,
  refs: RefRegistry,
  args: SampleArgs,
): Promise<SampleResult> {
  const durationMs = Math.min(Math.max(args.durationMs, 1), MAX_DURATION_MS);
  const everyFrame = args.everyFrame ?? false;
  const intervalMs = Math.max(args.intervalMs ?? 100, 16);
  const scope: "element" | "window" = args.target ? "element" : "window";

  if (!args.target && BBOX_METRICS.has(args.metric)) {
    throw new Error(
      `sample: metric "${args.metric}" needs a target element (bbox* is meaningless for the window)`,
    );
  }

  const params = { metric: args.metric, durationMs, everyFrame, intervalMs, maxSeries: MAX_SERIES };
  let series: Array<{ tMs: number; value: number }>;
  if (args.target) {
    let loc: Locator;
    try {
      loc = locatorFor(page, refs, args.target);
    } catch (e) {
      throw new Error(`sample: ${e instanceof Error ? e.message : String(e)}`);
    }
    series = await loc.evaluate(elementSampler as never, params);
  } else {
    series = await page.evaluate(windowSampler as never, params);
  }

  // `summary` is always cheap to compute and included. The full `series` is
  // omitted when the caller asked for `summary:true` OR (caller unset) the
  // window is large — long high-rate windows serialise huge and the agent
  // usually just needs the signal: did it move, bounds, when it first changed.
  const summary = summariseSeries(series);
  const omitSeries = shouldOmitSeries(args.summary, series.length);
  const autoSummarised = omitSeries && args.summary === undefined;
  return {
    metric: args.metric,
    scope,
    durationMs,
    mode: everyFrame ? "raf" : "interval",
    ...(everyFrame ? {} : { intervalMs }),
    count: series.length,
    ...(omitSeries ? {} : { series }),
    summary,
    ...(autoSummarised ? { autoSummarised: true } : {}),
    ...(series.length >= MAX_SERIES ? { truncated: true } : {}),
  };
}
