// Per-session cumulative metrics. Piggybacks on the existing per-call
// `tokensEstimate` + call-timing data the dispatch wrapper already has in hand —
// no new instrumentation in tool handlers, no per-call disk writes. Read-only
// from the agent's side via the `session_metrics` tool.
//
// Pairs with `export_session_report`: that one bundles the session's QA evidence
// (url, console errors, recent network summary, named regions, live sessions);
// this one rolls up the session's TOOL-CALL EVIDENCE (how many calls, how
// expensive, what failed, what was denied) so an agent / consumer can audit
// dispatch behaviour without re-walking a transcript.
//
// Tracks five counters per tool name (callsByTool, durationMsByTool,
// errorsByTool) plus two scalars (tokensEstimateSum, capabilityDenials).
// `capabilityDenials` is intentionally not per-tool: the denial is a property
// of the capability config, not the tool — when an agent hits one, the fix
// is at the capability layer and the count alone is the useful signal.

/** Per-tool counter row. */
export interface ToolCounter {
  /** Total dispatches against this tool name in this session. */
  count: number;
  /** Sum of wall-clock dispatch latency in milliseconds. */
  durationMs: number;
  /** Dispatches whose first JSON result was shaped `{ok: false, ...}` and was
   *  NOT a capability denial. Capability denials are tracked separately on the
   *  session-wide `capabilityDenials` scalar (one source of truth). */
  errors: number;
}

/** Outcome classifier passed from the dispatch wrapper. */
export type DispatchOutcome = "ok" | "error" | "denied";

export class SessionMetrics {
  /** Wall-clock instant the session was created. Mirrored on the rolled-up
   *  result so the consumer can derive duration without a second tool call. */
  readonly startedAt: number;
  /** Per-tool counters. Lazily created on first dispatch of each tool. */
  private byTool = new Map<string, ToolCounter>();
  /** Sum of `tokensEstimate` across every dispatched call. The field is on the
   *  result envelope (set by every tool that wraps a body via the standard
   *  helper); we read it back here so a session-wide token budget is one
   *  lookup rather than re-walking each tool's transcript. */
  private tokensSum = 0;
  /** Count of capability-denied dispatches across the whole session — the
   *  config-shape signal, see module header. */
  private denials = 0;

  constructor(startedAt: number = Date.now()) {
    this.startedAt = startedAt;
  }

  /** Record one dispatch. `durationMs` is the wall-clock latency the wrapper
   *  measured; `tokensEstimate` is the `tokensEstimate` field from the result
   *  envelope (or `undefined` if the result didn't carry one — e.g. an image-
   *  only response). Outcome `denied` means the gate refused before dispatch. */
  record(
    tool: string,
    outcome: DispatchOutcome,
    durationMs: number,
    tokensEstimate?: number,
  ): void {
    const row = this.byTool.get(tool) ?? { count: 0, durationMs: 0, errors: 0 };
    row.count += 1;
    row.durationMs += Math.max(0, durationMs);
    if (outcome === "error") row.errors += 1;
    this.byTool.set(tool, row);
    if (outcome === "denied") this.denials += 1;
    if (typeof tokensEstimate === "number" && Number.isFinite(tokensEstimate)) {
      this.tokensSum += tokensEstimate;
    }
  }

  /** Snapshot the current rollup. The returned object is plain JSON — safe to
   *  serialise straight onto the `session_metrics` tool envelope. */
  snapshot(now: number = Date.now()): {
    callsByTool: Record<string, number>;
    durationMsByTool: Record<string, number>;
    errorsByTool: Record<string, number>;
    tokensEstimateSum: number;
    capabilityDenials: number;
    sessionStartedAt: string;
    sessionDurationMs: number;
  } {
    const callsByTool: Record<string, number> = {};
    const durationMsByTool: Record<string, number> = {};
    const errorsByTool: Record<string, number> = {};
    // Emit tool entries in insertion order so two snapshots taken back-to-back
    // are stable (matters for diff-based assertions in tests).
    for (const [tool, row] of this.byTool) {
      callsByTool[tool] = row.count;
      durationMsByTool[tool] = row.durationMs;
      if (row.errors > 0) errorsByTool[tool] = row.errors;
    }
    return {
      callsByTool,
      durationMsByTool,
      errorsByTool,
      tokensEstimateSum: this.tokensSum,
      capabilityDenials: this.denials,
      sessionStartedAt: new Date(this.startedAt).toISOString(),
      sessionDurationMs: Math.max(0, now - this.startedAt),
    };
  }
}
