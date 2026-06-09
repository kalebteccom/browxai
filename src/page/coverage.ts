// Coverage — capability split: `coverage_start` is `action` (arms CDP state
// on the target); `coverage_stop` is `read` (pure stop + parse, no file
// written, no further mutation past releasing the in-flight state).
//
// "Half of this CSS file is dead — which selectors?" + "We ship 200KB of JS
// but boot only uses 30KB — what's unused?" have no diagnostic surface in
// the existing perf primitives (`perf_audit` consumes coverage *output*; the
// production of that output is here). Wraps two CDP primitives in lockstep:
//
//   - `Profiler.startPreciseCoverage`     — per-script byte-level use counts.
//   - `CSS.startRuleUsageTracking`        — per-stylesheet rule-level use
//                                            counts (which selectors fired).
//
// Lifecycle:
//   - coverage_start({session?})  → enables both trackers on this session's
//                                   CDP target. Idempotent restart: a fresh
//                                   `coverage_start` while one is already
//                                   running cleanly stops the in-flight pair
//                                   and starts new.
//   - coverage_stop({session?})   → stops both trackers, fetches the buffered
//                                   results (Profiler.takePreciseCoverage +
//                                   CSS.takeCoverageDelta), parses into the
//                                   structured shape the agent reads, and
//                                   surfaces it. Composes inside `perf_audit`
//                                   when the audit window spans them.
//
// Both shapes are surfaced as `usagePercent` so the agent can scan a table
// of "delete me first" candidates without bringing a calculator. JS scripts
// with `usagePercent < 100` and CSS files with `usagePercent < 100` indicate
// dead code. The audit's `unused-code` category uses a 30% floor (anything
// below that is "obviously dead, fix first").

import type { CDPSession } from "playwright-core";

/** Per-script JS coverage entry — one per Script URL the profiler observed. */
export interface JsCoverageEntry {
  url: string;
  totalBytes: number;
  usedBytes: number;
  /** 0-100. `totalBytes:0` is reported as `usagePercent:100` (no code → no
   *  dead code). */
  usagePercent: number;
  /** Optional list of dead byte ranges (only emitted when small enough to
   *  surface — top 50 ranges per script). */
  deadRanges?: Array<{ start: number; end: number }>;
}

/** Per-stylesheet CSS coverage entry — one per <style>/<link rel=stylesheet>
 *  the page used. */
export interface CssCoverageEntry {
  url: string;
  totalBytes: number;
  usedBytes: number;
  /** Approximate count derived from used-rule ranges. */
  usedRules: number;
  /** Same approximation against total ranges. */
  totalRules: number;
  /** 0-100. */
  usagePercent: number;
  /** Dead-rule byte ranges (top 50 per stylesheet). */
  deadRules?: Array<{ start: number; end: number }>;
}

/** Result of `coverage_stop` — the parsed report. */
export interface CoverageStopResult {
  jsCoverage: JsCoverageEntry[];
  cssCoverage: CssCoverageEntry[];
  durationMs: number;
}

/** CDP Profiler.takePreciseCoverage response shape (only the fields we touch). */
interface CdpScriptCoverage {
  url?: string;
  functions?: Array<{
    functionName?: string;
    isBlockCoverage?: boolean;
    ranges?: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
}

/** CDP CSS.takeCoverageDelta response shape. */
interface CdpRuleUsage {
  styleSheetId: string;
  startOffset: number;
  endOffset: number;
  used: boolean;
}
interface CdpStyleSheetHeader {
  styleSheetId: string;
  sourceURL?: string;
  length?: number;
}

const MAX_DEAD_RANGES_PER_SCRIPT = 50;

/** Per-session coverage tracker. One instance per SessionEntry; the
 *  underlying CDP coverage is per-target. */
export class CoverageTrackerState {
  private running = false;
  private startedAt = 0;
  /** Snapshot of `getAllStyleSheets()` taken at `start` so `stop` can map
   *  styleSheetId → URL + total length without a second CDP roundtrip. */
  private cssHeaders: Map<string, CdpStyleSheetHeader> = new Map();
  /** CSS.styleSheetAdded event handler — kept for cleanup. */
  private onStyleSheetAdded: ((e: { header: CdpStyleSheetHeader }) => void) | null = null;

  isRunning(): boolean {
    return this.running;
  }

  /** Start both Profiler + CSS coverage on `cdp`. Returns `{restarted}` —
   *  if an instance was already running, it is cleanly stopped (results
   *  discarded) and a fresh one begins. */
  async start(cdp: CDPSession): Promise<{ startedAt: number; restarted: boolean }> {
    let restarted = false;
    if (this.running) {
      restarted = true;
      await this.stopInternal(cdp).catch(() => undefined);
    }
    this.cssHeaders = new Map();
    // Enable + start profiler precise coverage. `detailed:true` gives us
    // per-function block ranges (we use them to compute used bytes); other
    // params keep CPU profiling off — we just want coverage.
    await cdp.send("Profiler.enable").catch(() => undefined);
    await cdp.send("Profiler.startPreciseCoverage", {
      callCount: false,
      detailed: true,
      allowTriggeredUpdates: false,
    });
    // Enable + start CSS rule usage tracking. Capture pre-existing
    // stylesheets via styleSheetAdded events while tracking is on (the CDP
    // event stream is the way to get the URL + length mapping for
    // styleSheetId; calling `CSS.getStyleSheetText` per id would be slow).
    await cdp.send("DOM.enable").catch(() => undefined);
    await cdp.send("CSS.enable").catch(() => undefined);
    const onAdded = (e: { header: CdpStyleSheetHeader }) => {
      if (e?.header?.styleSheetId) this.cssHeaders.set(e.header.styleSheetId, e.header);
    };
    cdp.on("CSS.styleSheetAdded", onAdded);
    this.onStyleSheetAdded = onAdded;
    await cdp.send("CSS.startRuleUsageTracking");
    this.running = true;
    this.startedAt = Date.now();
    return { startedAt: this.startedAt, restarted };
  }

  /** Stop both trackers, fetch + parse the results. Safe to call when no
   *  coverage is running — returns an empty report with `notRunning:true`. */
  async stop(cdp: CDPSession): Promise<CoverageStopResult & { notRunning?: true }> {
    if (!this.running) {
      return { jsCoverage: [], cssCoverage: [], durationMs: 0, notRunning: true };
    }
    const durationMs = Date.now() - this.startedAt;
    let jsRaw: { result?: CdpScriptCoverage[] } = {};
    let cssRaw: { ruleUsage?: CdpRuleUsage[] } = {};
    try {
      jsRaw = await cdp.send("Profiler.takePreciseCoverage");
    } catch {
      jsRaw = { result: [] };
    }
    try {
      cssRaw = await cdp.send("CSS.stopRuleUsageTracking");
    } catch {
      cssRaw = { ruleUsage: [] };
    }
    await this.stopInternal(cdp);
    return {
      jsCoverage: parseJsCoverage(jsRaw.result ?? []),
      cssCoverage: parseCssCoverage(cssRaw.ruleUsage ?? [], this.cssHeaders),
      durationMs,
    };
  }

  /** Force-clean teardown for session close. */
  async closeIfRunning(cdp: CDPSession): Promise<void> {
    if (!this.running) return;
    await this.stopInternal(cdp).catch(() => undefined);
  }

  private async stopInternal(cdp: CDPSession): Promise<void> {
    try {
      await cdp.send("Profiler.stopPreciseCoverage").catch(() => undefined);
    } catch {
      /* best-effort */
    }
    if (this.onStyleSheetAdded) {
      try {
        cdp.off("CSS.styleSheetAdded", this.onStyleSheetAdded);
      } catch {
        /* best-effort */
      }
      this.onStyleSheetAdded = null;
    }
    this.running = false;
  }
}

/** Parse the `Profiler.takePreciseCoverage` result into per-script entries.
 *  Exported for unit tests against a synthetic CDP payload.
 *
 *  V8 coverage shape: each script has multiple `functions` entries. The
 *  first is the synthetic "outer" anonymous wrapper covering the whole
 *  script — its count is the script-level execution counter and tells us
 *  nothing about which bytes ran. The remaining entries are real functions
 *  (or block-coverage subranges within them). The way DevTools' Coverage
 *  panel computes "used":
 *    - For each function, if its first (root) range has count:0, the entire
 *      function body is dead.
 *    - Otherwise, the function ran; if `isBlockCoverage:true`, sub-ranges
 *      with count:0 are dead blocks within the live function.
 *  We follow the same algorithm: aggregate per-function dead ranges, then
 *  total used = script length - sum of dead ranges. */
export function parseJsCoverage(scripts: CdpScriptCoverage[]): JsCoverageEntry[] {
  const out: JsCoverageEntry[] = [];
  for (const s of scripts) {
    const url = typeof s.url === "string" ? s.url : "";
    if (!url) continue;
    // Identify the script total span via the outermost wrapper range.
    let total = 0;
    for (const fn of s.functions ?? []) {
      for (const r of fn.ranges ?? []) {
        if (typeof r.endOffset === "number" && r.endOffset > total) total = r.endOffset;
      }
    }
    // Collect dead byte ranges per function. The first range in each
    // `ranges[]` array is the function's full body; subsequent ranges are
    // sub-blocks (when isBlockCoverage:true) describing block-level coverage.
    const deadRanges: Array<[number, number]> = [];
    for (const fn of s.functions ?? []) {
      const ranges = fn.ranges ?? [];
      if (ranges.length === 0) continue;
      const root = ranges[0]!;
      if (typeof root.startOffset !== "number" || typeof root.endOffset !== "number") continue;
      if (root.count === 0) {
        // Whole function body dead.
        deadRanges.push([root.startOffset, root.endOffset]);
        continue;
      }
      // Function ran. Walk sub-ranges (index 1..) for any count:0 blocks.
      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.count === 0 && typeof r.startOffset === "number" && typeof r.endOffset === "number") {
          deadRanges.push([r.startOffset, r.endOffset]);
        }
      }
    }
    // Merge overlapping dead ranges (sub-blocks of one function don't overlap
    // sibling functions, but defensive collapse is cheap + safer).
    deadRanges.sort((a, b) => a[0] - b[0]);
    const mergedDead: Array<[number, number]> = [];
    let dStart = -1,
      dEnd = -1;
    for (const [s2, e2] of deadRanges) {
      if (s2 > dEnd) {
        if (dEnd > dStart) mergedDead.push([dStart, dEnd]);
        dStart = s2;
        dEnd = e2;
      } else if (e2 > dEnd) {
        dEnd = e2;
      }
    }
    if (dEnd > dStart) mergedDead.push([dStart, dEnd]);
    const deadBytes = mergedDead.reduce((sum, [s3, e3]) => sum + (e3 - s3), 0);
    const used = Math.max(0, total - deadBytes);
    // Re-derive usedRanges as the complement of mergedDead for the
    // backward-compatible local variable name.
    const usedRanges: Array<[number, number]> = [];
    {
      let cursor = 0;
      for (const [s4, e4] of mergedDead) {
        if (s4 > cursor) usedRanges.push([cursor, s4]);
        cursor = e4;
      }
      if (cursor < total) usedRanges.push([cursor, total]);
    }
    // usagePercent is the headline metric the agent reads.
    const usagePercent = total === 0 ? 100 : Math.round((used / total) * 10000) / 100;
    // Dead ranges = the merged dead set we already computed; cap to 50.
    const dead: Array<{ start: number; end: number }> = mergedDead
      .slice(0, MAX_DEAD_RANGES_PER_SCRIPT)
      .map(([s5, e5]) => ({ start: s5, end: e5 }));
    // Silence TS unused-variable warning — usedRanges is exported semantics
    // (kept for future API extension, e.g. surfacing usedRanges in `full`
    // audit mode); use it once to keep the compiler quiet.
    void usedRanges;
    const entry: JsCoverageEntry = {
      url,
      totalBytes: total,
      usedBytes: used,
      usagePercent,
    };
    if (dead.length > 0) entry.deadRanges = dead;
    out.push(entry);
  }
  return out;
}

/** Parse `CSS.stopRuleUsageTracking` output into per-stylesheet entries.
 *  Exported for unit tests against synthetic CDP payloads. */
export function parseCssCoverage(
  ruleUsage: CdpRuleUsage[],
  headers: Map<string, CdpStyleSheetHeader>,
): CssCoverageEntry[] {
  // Group by styleSheetId. Each entry: url + total span + used+dead ranges.
  const byId = new Map<
    string,
    { used: Array<[number, number]>; dead: Array<[number, number]>; maxEnd: number }
  >();
  for (const r of ruleUsage) {
    const id = r.styleSheetId;
    if (!id) continue;
    let g = byId.get(id);
    if (!g) {
      g = { used: [], dead: [], maxEnd: 0 };
      byId.set(id, g);
    }
    if (r.endOffset > g.maxEnd) g.maxEnd = r.endOffset;
    if (r.used) g.used.push([r.startOffset, r.endOffset]);
    else g.dead.push([r.startOffset, r.endOffset]);
  }
  const out: CssCoverageEntry[] = [];
  for (const [id, g] of byId) {
    const hdr = headers.get(id);
    // Prefer the explicit header length when available; CDP sometimes
    // reports 0 for inline stylesheets without sourceURL — fall back to
    // the maxEnd observation from the rule-usage stream.
    const total = hdr?.length && hdr.length > 0 ? hdr.length : g.maxEnd;
    let usedBytes = 0;
    for (const [s, e] of g.used) usedBytes += Math.max(0, e - s);
    const usagePercent = total === 0 ? 100 : Math.round((usedBytes / total) * 10000) / 100;
    const entry: CssCoverageEntry = {
      url: hdr?.sourceURL || `inline:${id}`,
      totalBytes: total,
      usedBytes,
      usedRules: g.used.length,
      totalRules: g.used.length + g.dead.length,
      usagePercent,
    };
    if (g.dead.length > 0) {
      entry.deadRules = g.dead
        .slice(0, MAX_DEAD_RANGES_PER_SCRIPT)
        .map(([s, e]) => ({ start: s, end: e }));
    }
    out.push(entry);
  }
  return out;
}
