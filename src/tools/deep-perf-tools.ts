import { requireCdp } from "../engine/index.js";
import { estimateTokens } from "../util/tokens.js";
import {
  DEFAULT_TRACE_CATEGORIES,
  defaultTracePath,
  writeTraceFile,
  readTraceFile,
  extractInsights,
} from "../page/perf.js";
import { ALL_AUDIT_CATEGORIES } from "../page/perf-audit.js";
import { runPerfAudit } from "../page/perf-audit-runner.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/** Cheap one-pass counter for perf_stop's inline summary — gives the agent a
 *  one-glance "is this trace worth running insights on?" without parsing
 *  twice. Matches the surfaces extractInsights exposes. */
type PerfCountKey =
  "longTaskCount" | "layoutShiftCount" | "renderBlockingCount" | "lcpCandidateCount";

/** Whether a `ResourceSendRequest` event is render-blocking. */
function isRenderBlockingEvent(ev: import("../page/perf.js").TraceEvent): boolean {
  const data = (ev.args && ev.args.data) as Record<string, unknown> | undefined;
  const rb = data && typeof data.renderBlocking === "string" ? data.renderBlocking : "";
  return rb === "blocking" || rb === "in_body_parser_blocking";
}

/** Whether an event is a long task (`RunTask`/`LongTask` ≥ 50ms). */
function isLongTaskEvent(ev: import("../page/perf.js").TraceEvent, name: string): boolean {
  return (
    (name === "RunTask" || name === "LongTask") && typeof ev.dur === "number" && ev.dur / 1000 >= 50
  );
}

/** Classify a trace event into the perf counter it bumps, or null. */
function perfCountKey(ev: import("../page/perf.js").TraceEvent): PerfCountKey | null {
  if (!ev || typeof ev !== "object") return null;
  const name = typeof ev.name === "string" ? ev.name : "";
  if (!name) return null;
  if (isLongTaskEvent(ev, name)) return "longTaskCount";
  if (name === "LayoutShift") return "layoutShiftCount";
  if (name === "largestContentfulPaint::Candidate") return "lcpCandidateCount";
  if (name === "ResourceSendRequest" && isRenderBlockingEvent(ev)) return "renderBlockingCount";
  return null;
}

function inlineCounts(
  events: import("../page/perf.js").TraceEvent[],
): Record<PerfCountKey, number> {
  const counts: Record<PerfCountKey, number> = {
    longTaskCount: 0,
    layoutShiftCount: 0,
    renderBlockingCount: 0,
    lcpCandidateCount: 0,
  };
  for (const ev of events) {
    const key = perfCountKey(ev);
    if (key) counts[key]++;
  }
  return counts;
}

/**
 * Deep-diagnostics tools — the heavyweight observation surface an agent reaches
 * for when a flow is slow, leaky, or non-deterministic: performance tracing
 * (perf_start / perf_stop / perf_insights), the orchestrated perf_audit, JS+CSS
 * coverage, layout-thrash tracing, V8 heap snapshots + retainer / memory-diff
 * queries, the virtual clock + seeded RNG determinism knobs, and the
 * network-aware act_and_wait_for_network / poll_eval waiters. Every block is
 * registered through the shared `ToolHost` seam; the host owns the closures
 * (gate, engine-gate, session, workspace, batch dispatch), this module owns the
 * registrations.
 */

/**
 * Deep tools — performance tracing & audit. `perf_start` / `perf_stop` (Chromium
 * trace capture), `perf_insights` (post-hoc trace analysis), and `perf_audit`
 * (the category-driven optimisation pass). All CDP-deep (refused off Chromium).
 * Registered through the shared `ToolHost` seam.
 */
export function registerDeepPerfTools(host: ToolHost): void {
  const { z, register, gateCheck, engineGate, entryFor, workspace } = host;

  // -------- performance tracing --------

  register(
    "perf_start",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Start a CDP performance trace on this session (`Tracing.start`), to find out why an interaction was slow. Stop it with `perf_stop`, which writes a Chromium-format trace under `<workspace>/perf-traces/`; `perf_insights` then extracts long tasks, layout shifts, render-blocking resources, LCP and navigation timing from that file. Use `perf_audit` for a one-call report with remediations. One trace per session: calling `perf_start` while one runs stops it (events discarded) and starts fresh, so an agent that lost track can just call again. Empty `categories` uses a DevTools-Performance-like default (devtools.timeline, loading, blink.user_timing, frame). On `attached` sessions `perf_stop` is required to detach the trace buffer from your Chrome; `close_session` also cleans up.",
      inputSchema: {
        categories: z
          .array(z.string())
          .optional()
          .describe(
            `Tracing categories to include. Omit for the default set (${DEFAULT_TRACE_CATEGORIES.join(", ")}).`,
          ),
        ...SESSION_ARG,
      },
    },
    async ({ categories, session }) => {
      const g = gateCheck("perf_start");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("perf_start", e);
      if (eg) return eg;
      try {
        const r = await e.perf.start(requireCdp(e.session), { categories });
        const body: Record<string, unknown> = {
          ok: true,
          running: true,
          categories: r.categories,
          restarted: r.restarted,
          hint: "Drive your action(s), then call perf_stop to flush the trace. Insights come from perf_insights({tracePath}).",
        };
        if (r.restarted) {
          body.warning =
            "A prior perf_start was still active — it has been cleanly stopped (events discarded) and a fresh trace started.";
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );

  register(
    "perf_stop",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Stop the running performance trace and write it to a workspace-rooted JSON file (`Tracing.end`). Returns `{ path, bytes, eventCount, categories, durationMs }` plus a short summary (long-task, layout-shift and render-blocking counts), so you may not need `perf_insights`. Default path `<workspace>/perf-traces/<sessionId>-<ts>.json`; `path` must resolve inside `$BROWX_WORKSPACE`. Safe to call repeatedly: with no trace running it returns `notRunning:true`. The file loads in DevTools' Performance panel and `chrome://tracing`.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output path for the trace JSON. Default: <workspace>/perf-traces/<sessionId>-<ts>.json. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ path, session }) => {
      const g = gateCheck("perf_stop");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("perf_stop", e);
      if (eg) return eg;
      try {
        const r = await e.perf.stop(requireCdp(e.session));
        if (r.notRunning) {
          const body = {
            ok: true,
            notRunning: true,
            hint: "No trace was active for this session — perf_stop is idempotent; call perf_start first.",
          };
          const tokensEstimate = estimateTokens(JSON.stringify(body));
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
            ],
          };
        }
        const targetPath = path ?? defaultTracePath(workspace.root, e.id);
        // `targetPath` is rooted at workspace.root by construction (defaultTracePath
        // uses workspace.root; explicit `path` is enforced by resolvePerfTracePath
        // inside writeTraceFile).
        const written = writeTraceFile(
          workspace.root,
          targetPath,
          r.events,
          { categories: r.categories, sessionId: e.id, durationMs: r.durationMs },
          "perf_stop",
        );
        // Tiny inline summary — agent can decide whether to spend tokens on
        // perf_insights or move on. Doesn't reparse: we count event names only.
        const summary = inlineCounts(r.events);
        const body: Record<string, unknown> = {
          ok: true,
          path: written.resolved,
          bytes: written.bytes,
          eventCount: r.events.length,
          categories: r.categories,
          durationMs: r.durationMs,
          summary,
          hint: "Call perf_insights({tracePath}) for structured long-tasks / layout-shifts / render-blocking / LCP / navigation-timing data.",
        };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: the trace buffer on the human's Chrome has been released. The JSON file remains under $BROWX_WORKSPACE.";
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );

  register(
    "perf_insights",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Extract structured insights from a trace file written by `perf_stop` (or any Chromium-format trace). Returns `{ longTasks, layoutShifts, renderBlocking, lcpCandidates, navigation?, totals }`: the top 50 long tasks (50 ms or more of blocking work, longest first), layout shifts with per-shift score and sum, render-blocking CSS and JS with duration, LCP candidates (the last is the effective LCP), and navigation milestones (FP, FCP, DCL, load) relative to `navigationStart`. `tracePath` must resolve inside `$BROWX_WORKSPACE`.",
      inputSchema: {
        tracePath: z
          .string()
          .describe(
            "Workspace-rooted path to a chromium trace JSON file (the path returned by perf_stop).",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ tracePath, session: _session }) => {
      const g = gateCheck("perf_insights");
      if (g) return g;
      // No session-touching needed — pure file read + parse. But we still
      // resolve the entry to honour the SESSION_ARG contract for consistency.
      try {
        const { events, metadata } = readTraceFile(workspace.root, tracePath, "perf_insights");
        const insights = extractInsights(events);
        const body: Record<string, unknown> = {
          ok: true,
          tracePath,
          eventCount: events.length,
          metadata: metadata ?? null,
          insights,
        };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );

  // -------- perf optimization module --------
  //
  // Four new primitives that promote browxai's perf surface from
  // measurement to actionable:
  //   - perf_audit            → orchestrated audit across 8 pluggable
  //                              categories, with remediation suggestions.
  //                              Summary mode capped at 2000 tokens.
  //   - coverage_start/stop   → CDP Profiler.startPreciseCoverage +
  //                              CSS.startRuleUsageTracking pair, exposing
  //                              per-script + per-stylesheet usage% for the
  //                              dead-code analysis the audit consumes.
  //   - layout_thrash_trace   → focused 5-30s trace just for forced
  //                              synchronous layouts + LayoutShift events,
  //                              aggregated by originating call-stack.
  //   - memory_diff           → pure-function heap-snapshot diff (two
  //                              existing `.heapsnapshot` paths in) →
  //                              retainer-growth report.
  //
  // Capability split (also in util/capabilities.ts):
  //   perf_audit, coverage_stop, layout_thrash_trace, memory_diff → `read`
  //   coverage_start                                                 → `action`

  register(
    "perf_audit",
    {
      capability: "read",
      batchable: true,
      deep: true,
      description:
        'Run the performance analysers on this session and return a report with remediations: the one-call alternative to `perf_start`, `perf_stop` and `perf_insights`. It records a CDP trace, JS and CSS coverage and network response metadata for `durationMs` (default 5000, max 30000), then runs 8 analysers. `categories` (default all): `render-blocking`, `unused-code` (scripts or stylesheets under 30% used), `oversize-images` (over 500 KB), `layout-thrashing` (over 5 forced layouts), `long-tasks` (over 50 ms), `leak-suspects` (over 10% retainer growth; needs `memory_diff` data), `cache-opportunities` (static assets with missing or short Cache-Control), `font-loading` (fonts loaded over 200 ms after document start). Returns `{summary:{score, topIssues[]}, byCategory:{[cat]:{issues[], remediations[]}}, evidence:{tracePath, coveragePath?}, warnings[], tokensEstimate}`. `format:"summary"` (default) keeps 3 issues and 3 remediations per category within a 2000-token budget (dropped entries are noted in `warnings[]`); `"full"` is unbounded. Evidence files are written under `<workspace>/perf/<sessionId>-audit-<ts>.json` (plus coverage JSON) and open in DevTools.',
      inputSchema: {
        categories: z
          .array(z.enum(ALL_AUDIT_CATEGORIES as [string, ...string[]]))
          .optional()
          .describe("Subset of audit categories. Default = all 8."),
        durationMs: z
          .number()
          .int()
          .positive()
          .max(30_000)
          .optional()
          .describe(
            "Observation window in ms. Default 5000, max 30000. Longer windows give more data but cost more wall-clock.",
          ),
        format: z
          .enum(["summary", "full"])
          .optional()
          .describe(
            "`summary` (default) caps each category to 3 issues + enforces a 2000-token body budget. `full` is unbounded.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ categories, durationMs, format, session }) => {
      const g = gateCheck("perf_audit");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("perf_audit", e);
      if (eg) return eg;
      try {
        const r = await runPerfAudit(requireCdp(e.session), workspace.root, e.id, {
          categories: categories,
          durationMs,
          format,
        });
        const body: Record<string, unknown> = {
          ok: true,
          summary: r.report.summary,
          byCategory: r.report.byCategory,
          evidence: r.evidence,
          durationMs: r.durationMs,
          categoriesRun: r.categoriesRun,
          warnings: r.report.warnings,
        };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: trace + coverage state has been released on the human's Chrome. Evidence files remain under $BROWX_WORKSPACE.";
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );
}
