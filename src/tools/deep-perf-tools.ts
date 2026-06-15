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
function inlineCounts(events: import("../page/perf.js").TraceEvent[]): {
  longTaskCount: number;
  layoutShiftCount: number;
  renderBlockingCount: number;
  lcpCandidateCount: number;
} {
  let longTaskCount = 0,
    layoutShiftCount = 0,
    renderBlockingCount = 0,
    lcpCandidateCount = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const name = typeof ev.name === "string" ? ev.name : "";
    if (!name) continue;
    if (
      (name === "RunTask" || name === "LongTask") &&
      typeof ev.dur === "number" &&
      ev.dur / 1000 >= 50
    )
      longTaskCount++;
    else if (name === "LayoutShift") layoutShiftCount++;
    else if (name === "ResourceSendRequest") {
      const data = (ev.args && ev.args.data) as Record<string, unknown> | undefined;
      const rb = data && typeof data.renderBlocking === "string" ? data.renderBlocking : "";
      if (rb === "blocking" || rb === "in_body_parser_blocking") renderBlockingCount++;
    } else if (name === "largestContentfulPaint::Candidate") lcpCandidateCount++;
  }
  return { longTaskCount, layoutShiftCount, renderBlockingCount, lcpCandidateCount };
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
  const {
    z,
    register,
    gateCheck,
    engineGate,
    entryFor,
    workspace,
  } = host;

  // -------- performance tracing --------

  register(
    "perf_start",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Arm a CDP performance trace on this session — wraps `Tracing.start`. Use to diagnose **why** a slow interaction was slow: a paired `perf_stop` flushes a chromium-format trace file under `<workspace>/perf-traces/` and a `perf_insights` call extracts structured long-tasks / layout-shifts / render-blocking / LCP / navigation-timing data from it. Per-session; one trace in flight at a time. **Idempotent restart:** calling `perf_start` while a trace is already running cleanly stops the in-flight one (events discarded) and starts fresh — an agent that lost track of state always recovers by just calling again. Empty `categories` uses a DevTools-Performance-equivalent default (devtools.timeline + loading + blink.user_timing + frame). Tracing is per-target (the attached chromium); BYOB sessions: a `perf_stop` is REQUIRED to detach the trace buffer on the human's Chrome — `close_session` also cleans up on its way out.",
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
        "Stop the in-flight performance trace and flush it to a workspace-rooted JSON file. Wraps `Tracing.end`. Returns `{ path, bytes, eventCount, categories, durationMs }` plus a tiny summary (long-task count, layout-shift count, render-blocking count) so you don't have to call `perf_insights` for a one-glance answer. Default file path: `<workspace>/perf-traces/<sessionId>-<ts>.json` (override with `path`, which is rejected if it resolves outside `$BROWX_WORKSPACE`). **Safe to call any number of times:** if no trace is running, returns `notRunning:true` rather than an error — pairs cleanly with idempotent agent retries. The file is chromium-tracing format (`{ traceEvents, metadata }`), so it loads in DevTools' Performance panel and `chrome://tracing` directly.",
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
        "Extract structured insights from a written performance trace file. Returns `{ longTasks, layoutShifts, renderBlocking, lcpCandidates, navigation?, totals }`: top-50 long tasks (≥50ms blocking work, sorted longest-first); layout shifts with per-shift score + sum; render-blocking CSS/JS resources with duration; LCP candidates (final = effective LCP); navigation milestones (FP / FCP / DCL / load) relative to `navigationStart`. `tracePath` is workspace-rooted (the path `perf_stop` returned) and rejected if it escapes `$BROWX_WORKSPACE`. Same chromium-tracing JSON format the DevTools Performance panel consumes — bring-your-own trace works too.",
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
        'Run a structured performance audit on this session and return remediation-shaped findings — the headline tool. Records a CDP trace + JS/CSS precise coverage + network response metadata for `durationMs` (default 5000, max 30000), then runs 8 pluggable category analysers against the assembled context and composes a report. **Categories** (default = all): `render-blocking` (resources blocking first paint), `unused-code` (scripts/stylesheets with <30% usage), `oversize-images` (>500KB), `layout-thrashing` (>5 forced sync layouts), `long-tasks` (>50ms main-thread blockers), `leak-suspects` (>10% retainer growth — requires `memory_diff` data passed via the runner), `cache-opportunities` (static assets with missing/short Cache-Control), `font-loading` (fonts loaded >200ms after document start). **Output shape:** `{summary:{score, topIssues[]}, byCategory:{[cat]:{issues[], remediations[]}}, evidence:{tracePath, coveragePath?}, warnings[], tokensEstimate}`. **`format`** (default `"summary"`) caps each category to 3 issues + 3 remediations AND enforces a 2000-token budget on the body — over-budget low/medium severity entries are dropped + a `warnings[]` entry surfaces it. `"full"` is unbounded. **Evidence files** (workspace-rooted): the trace under `<workspace>/perf/<sessionId>-audit-<ts>.json` + coverage JSON alongside; both are loadable in DevTools\' Performance / Coverage panels. Internally pluggable — future categories add by extending `ANALYSERS` in `src/page/perf-audit.ts` without changing this public surface. Capability `read` (non-mutating observation).',
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
