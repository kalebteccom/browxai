import { requireCdp } from "../engine/index.js";
import { withDeadline } from "../util/deadline.js";
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
import { runLayoutThrashTrace } from "../page/layout-thrash.js";
import { diffHeapSnapshots } from "../page/memory-diff.js";
import {
  takeHeapSnapshot,
  defaultHeapSnapshotPath,
  writeHeapSnapshotFile,
  readHeapSnapshotFile,
  queryRetainers,
} from "../page/heap.js";
import { matchesResponse } from "../page/await_network.js";
import { sanitizeUrl } from "../util/url-sanitizer.js";
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
export function registerDeepTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    engineGate,
    entryFor,
    workspace,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
    toolHandlers,
  } = host;

  // -------- performance tracing --------

  register(
    "perf_start",
    {
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

  register(
    "coverage_start",
    {
      description:
        "Arm precise JS + CSS coverage tracking on this session — wraps CDP `Profiler.startPreciseCoverage` (per-script byte-level use counts) + `CSS.startRuleUsageTracking` (per-stylesheet rule-level use counts) in lockstep. Use to identify dead JS + dead CSS that ships but boot never executes. Pairs with `coverage_stop` (returns the parsed report). Per-session; one lifecycle in flight at a time. **Idempotent restart:** calling `coverage_start` while a tracker is already running cleanly stops the in-flight one (results discarded) and starts fresh. Captures stylesheet metadata (URL + length) via the `CSS.styleSheetAdded` event stream during the tracking window. Capability `action` (mutates target state). The audit tool `perf_audit` calls this internally — only use the direct primitives when you want the raw report or want a longer window than the audit's default.",
      inputSchema: {
        ...SESSION_ARG,
      },
    },
    async ({ session }) => {
      const g = gateCheck("coverage_start");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("coverage_start", e);
      if (eg) return eg;
      try {
        const r = await e.coverage.start(requireCdp(e.session));
        const body: Record<string, unknown> = {
          ok: true,
          running: true,
          startedAt: r.startedAt,
          restarted: r.restarted,
          hint: "Drive your action(s), then call coverage_stop to get the {jsCoverage, cssCoverage} report.",
        };
        if (r.restarted) {
          body.warning =
            "A prior coverage_start was still active — it has been cleanly stopped (results discarded) and a fresh tracker started.";
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
    "coverage_stop",
    {
      description:
        "Stop precise JS + CSS coverage tracking and return the parsed report. Calls `Profiler.takePreciseCoverage` + `CSS.stopRuleUsageTracking` then aggregates the raw byte-range output into per-script + per-stylesheet entries. Returns `{ok, jsCoverage:[{url, totalBytes, usedBytes, usagePercent, deadRanges?}], cssCoverage:[{url, totalBytes, usedBytes, usedRules, totalRules, usagePercent, deadRules?}], durationMs}`. `usagePercent` is the agent's scan metric — `<30` indicates substantial dead code (the audit's `unused-code` analyser flags it). `deadRanges` / `deadRules` are top-50 byte ranges per file. **Safe to call any number of times:** if no tracker is running, returns `notRunning:true` rather than an error. Pure parsing + composition past the CDP fetches — no file written; the caller decides whether to persist the report. Capability `read`.",
      inputSchema: {
        ...SESSION_ARG,
      },
    },
    async ({ session }) => {
      const g = gateCheck("coverage_stop");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("coverage_stop", e);
      if (eg) return eg;
      try {
        const r = await e.coverage.stop(requireCdp(e.session));
        if (r.notRunning) {
          const body = {
            ok: true,
            notRunning: true,
            hint: "No coverage was active for this session — coverage_stop is idempotent; call coverage_start first.",
          };
          const tokensEstimate = estimateTokens(JSON.stringify(body));
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
            ],
          };
        }
        const body: Record<string, unknown> = {
          ok: true,
          jsCoverage: r.jsCoverage,
          cssCoverage: r.cssCoverage,
          durationMs: r.durationMs,
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

  register(
    "layout_thrash_trace",
    {
      description:
        'Record a focused CDP trace for `durationMs` (default 5000, max 30000) that captures forced synchronous layouts + LayoutShift + Recalc Style events, then aggregate by originating call-stack so the agent sees `"this rAF loop fired 200 forced layouts"` at a glance instead of paging through a 100MB chromium trace. Returns `{ok, forcedLayoutsCount, layoutShiftsCount, eventsByOrigin:[{originatingStack, count, totalDurationMs}], tracePath, durationMs}`. `originatingStack` reads from the trace\'s `stackTrace` field on each event (chromium populates it when DevTools is attached) — `"<anonymous>"` when no stack was attached. `tracePath` is a workspace-rooted JSON file under `<workspace>/perf/<sessionId>-layout-thrash-<ts>.json` — loadable in DevTools\' Performance panel for the full visual. Capped at the top 50 origins, sorted by count desc. Capability `read`.',
      inputSchema: {
        durationMs: z
          .number()
          .int()
          .positive()
          .max(30_000)
          .optional()
          .describe("Trace recording window in ms. Default 5000, max 30000."),
        ...SESSION_ARG,
      },
    },
    async ({ durationMs, session }) => {
      const g = gateCheck("layout_thrash_trace");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("layout_thrash_trace", e);
      if (eg) return eg;
      try {
        const r = await runLayoutThrashTrace(requireCdp(e.session), workspace.root, e.id, {
          durationMs,
        });
        const body: Record<string, unknown> = {
          ok: true,
          forcedLayoutsCount: r.forcedLayoutsCount,
          layoutShiftsCount: r.layoutShiftsCount,
          eventsByOrigin: r.eventsByOrigin,
          tracePath: r.tracePath,
          durationMs: r.durationMs,
        };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: trace buffer on the human's Chrome has been released. The JSON file remains under $BROWX_WORKSPACE.";
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
    "memory_diff",
    {
      description:
        "Diff two V8 heap snapshots (paths to existing `.heapsnapshot` files from `heap_snapshot`) and report retainer growth per node-type group. Pure function — no browser interaction; no CDP touch; reads + parses two existing JSON-shaped V8 heap snapshots on disk and emits the structured diff. **Inputs:** `beforePath` + `afterPath`, both workspace-rooted (path-escape rejected). **Output:** `{ok, retainerGrowth:[{node, type, sizeBefore, sizeAfter, deltaBytes, deltaPercent}], summary:{totalGrowth, top3Growers}}`. `node` is the V8 `${type}:${name}` display (matches `heap_retainers`'s shape). Groups whose `|deltaBytes| < 1024` are dropped as noise. Sorted by `deltaBytes` desc, capped at 100 rows. Typical leak-detection flow: `heap_snapshot` (before suspect interaction) → drive the action → `heap_snapshot` (after) → `memory_diff({beforePath, afterPath})`. The audit's `leak-suspects` analyser consumes this shape directly. Capability `read`.",
      inputSchema: {
        beforePath: z
          .string()
          .describe("Workspace-rooted path to a `.heapsnapshot` file (the 'before' snapshot)."),
        afterPath: z
          .string()
          .describe("Workspace-rooted path to a `.heapsnapshot` file (the 'after' snapshot)."),
        ...SESSION_ARG,
      },
    },
    async ({ beforePath, afterPath, session: _session }) => {
      const g = gateCheck("memory_diff");
      if (g) return g;
      // Pure file read + parse — no session touch required. SESSION_ARG
      // honoured for surface consistency with the sibling `perf_insights`.
      try {
        const r = diffHeapSnapshots(workspace.root, beforePath, afterPath, "memory_diff");
        const body: Record<string, unknown> = {
          ok: true,
          retainerGrowth: r.retainerGrowth,
          summary: r.summary,
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

  // -------- V8 heap snapshots --------

  register(
    "heap_snapshot",
    {
      description:
        "Take a V8 heap snapshot on this session's target — wraps CDP `HeapProfiler.takeHeapSnapshot`. The output file is the same `.heapsnapshot` JSON DevTools' Memory panel and `chrome://inspect` consume on drag-and-drop. Use to diagnose memory leaks: pair with `heap_retainers({snapshotPath, query})` to ask \"who's still pointing to objects named X / typed Y\" — the answer is invisible in `snapshot` / `find` because the leaked nodes are no longer in the DOM. Per-session; one-shot (a heap snapshot is a point-in-time capture, not a recording window). Default file path: `<workspace>/heap-snapshots/<sessionId>-<ts>.heapsnapshot` — explicit `path` is rejected if it escapes `$BROWX_WORKSPACE`. Snapshots are heavy (often tens to hundreds of MiB on a real page); don't take them in a tight loop.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output path for the .heapsnapshot file. Default: <workspace>/heap-snapshots/<sessionId>-<ts>.heapsnapshot. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ path, session }) => {
      const g = gateCheck("heap_snapshot");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("heap_snapshot", e);
      if (eg) return eg;
      try {
        const snapshotJson = await takeHeapSnapshot(requireCdp(e.session));
        const targetPath = path ?? defaultHeapSnapshotPath(workspace.root, e.id);
        const written = writeHeapSnapshotFile(
          workspace.root,
          targetPath,
          snapshotJson,
          "heap_snapshot",
        );
        const body: Record<string, unknown> = {
          ok: true,
          path: written.resolved,
          bytes: written.bytes,
          hint: "Call heap_retainers({snapshotPath, query:{name|type}}) to find what's holding suspect objects alive. Drag-and-drop this file onto chrome://inspect's Memory panel for the full interactive view.",
        };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: the snapshot was captured against the human's Chrome. The .heapsnapshot file remains under $BROWX_WORKSPACE.";
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
    "heap_retainers",
    {
      description:
        'Run a retainer query against a written `.heapsnapshot` file. Returns the top retainers (sorted by retainer self-size desc, capped at 50) of nodes whose display name and/or V8 type matches the query — directly answers "who\'s holding these objects alive?" without paging through DevTools\' Memory panel. Pure file read + in-process parse, no CDP touch. `query.name` defaults to exact match against the node\'s string-table name (use `nameMatch:"substring"` for containment); `query.type` filters by V8 node-type (`"closure"`, `"object"`, `"hidden"`, …). At least one of `name` / `type` is required — a match-everything query is never the right answer. `snapshotPath` is workspace-rooted; rejected if it escapes `$BROWX_WORKSPACE`. Same JSON format `heap_snapshot` writes — bring-your-own snapshot (downloaded from DevTools, saved by a CI run) works too.',
      inputSchema: {
        snapshotPath: z
          .string()
          .describe(
            "Workspace-rooted path to a .heapsnapshot file (the path returned by heap_snapshot).",
          ),
        query: z
          .object({
            name: z
              .string()
              .optional()
              .describe(
                'Match against the V8 string-table name of a node (e.g. "Cache", "MyLeakyClass").',
              ),
            type: z
              .string()
              .optional()
              .describe('Match against V8 node-type (e.g. "closure", "object", "hidden").'),
            nameMatch: z
              .enum(["exact", "substring"])
              .optional()
              .describe(
                'Default "exact". Use "substring" for containment matching against `name`.',
              ),
          })
          .describe("At least one of `name` or `type` is required."),
        ...SESSION_ARG,
      },
    },
    async ({ snapshotPath, query, session: _session }) => {
      const g = gateCheck("heap_retainers");
      if (g) return g;
      // Pure file read + parse — no session touch needed. We still honour
      // SESSION_ARG for consistency with the sibling `perf_insights`.
      try {
        const { parsed, resolved } = readHeapSnapshotFile(
          workspace.root,
          snapshotPath,
          "heap_retainers",
        );
        const result = queryRetainers(parsed, query);
        const body: Record<string, unknown> = {
          ok: true,
          snapshotPath: resolved,
          ...result,
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

  register(
    "clock",
    {
      description:
        'Control the page\'s virtual clock via CDP `Emulation.setVirtualTimePolicy` — deterministic testing of date-sensitive flows (renewal dates, "today" filters, scheduling, expiry edges) without changing the OS clock. Three modes: `freeze` pauses virtual time at `atIso` (or wall-clock now if omitted); `advance` jumps the clock by `byMs` or to an absolute `atIso`, then re-pins; `release` resumes real time. Per-session; persists across navigation (re-applied on main-frame nav in case CDP drops it). Independent of `network_emulate` / `cpu_emulate` — compose freely. **BYOB:** the policy stays in effect on the attached Chrome until released, reloaded, or closed; a `warning` field surfaces this in `attached` mode.',
      inputSchema: {
        mode: z
          .enum(["freeze", "advance", "release"])
          .describe(
            "freeze: pause virtual time at `atIso` (or now). advance: jump by `byMs` or to `atIso`. release: resume real time.",
          ),
        atIso: z
          .string()
          .optional()
          .describe(
            "ISO-8601 instant. freeze → pin time here; advance → jump to this absolute instant. Mutually exclusive with `byMs` on advance.",
          ),
        byMs: z
          .number()
          .int()
          .positive()
          .max(365 * 24 * 60 * 60 * 1000)
          .optional()
          .describe(
            "Advance only — relative jump in ms (max 1 year). Mutually exclusive with `atIso`.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ mode, atIso, byMs, session }) => {
      const g = gateCheck("clock");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("clock", e);
      if (eg) return eg;
      try {
        const {
          state,
          mode: appliedMode,
          appliedAtIso,
        } = await e.clock.apply(requireCdp(e.session), e.session.page(), { mode, atIso, byMs });
        const body: Record<string, unknown> = {
          ok: true,
          applied: {
            mode: appliedMode,
            nowIso: appliedAtIso,
            paused: state?.paused ?? false,
          },
        };
        if (e.mode === "attached") {
          body.warning =
            'BYOB / attached Chrome: this virtual-clock policy stays in effect on the attached browser even after browxai detaches — release it (mode:"release"), reload, or close the page when you\'re done. A page with a frozen wall clock is a debugging trap.';
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
    "seed_random",
    {
      description:
        "Override the page's `Math.random` with a deterministic Mulberry32 PRNG seeded from `seed`. For flake-repros where unseeded randomness drives id generation, dice / card / A-B picks, or jittered retry timing. Injected via Playwright `addInitScript`, so every new document in the session — including subsequent navigations — bootstraps the same override; the current page's main realm is re-seeded immediately so the effect is visible without navigating. Per-session; persists across navigation (re-applied on main-frame `framenavigated` for symmetry with `network_emulate` / `clock`). **MVP scope:** only `Math.random` is overridden — `crypto.randomUUID` / `crypto.getRandomValues` are NOT touched (web-crypto is a much bigger deterministic-stub surface; revisit later). Workers are out of scope (the init script runs in document realms, not worker realms). **BYOB:** the override is installed on the attached Chrome's context for as long as the context lives; surfaced as a `warning` in `attached` session mode.",
      inputSchema: {
        seed: z
          .number()
          .int()
          .min(0)
          .max(0xffffffff)
          .describe(
            "Non-negative integer in [0, 2^32 - 1]. The Mulberry32 state domain — 0 is valid.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ seed, session }) => {
      const g = gateCheck("seed_random");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const { state } = await e.seededRandom.apply(e.session.page().context(), e.session.page(), {
          seed,
        });
        const body: Record<string, unknown> = { ok: true, applied: state };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: this Math.random override is installed on the attached browser's context and stays in effect for as long as the context lives — close the tab / context when you're done to drop it.";
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
    "act_and_wait_for_network",
    {
      description:
        "Run ONE action and wait for a specific network response to complete — async SPAs fire follow-up requests after the action-result window, so `ActionResult.network` misses them. The waiter is armed BEFORE the action dispatches (no race). `action` is `{tool,args}` from the batch whitelist. `match` selects the response: `urlPattern` (case-insensitive substring), `method`, `status` — at least one required. Returns `{ action: <inner result>, network: { matched, method?, url?, status? } }` (url redacted, same as `network_read`). `timeoutMs` is the max wait (default 10000).",
      inputSchema: {
        action: z.object({
          tool: z.string().describe("Inner tool name (batch whitelist)."),
          args: z.record(z.unknown()).optional(),
        }),
        match: z
          .object({
            urlPattern: z
              .string()
              .optional()
              .describe("Case-insensitive substring of the request URL."),
            method: z.string().optional(),
            status: z.number().int().optional(),
          })
          .describe("At least one field required."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Max wait for the matching response (default 10000)."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("act_and_wait_for_network");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "act_and_wait_for_network") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `act_and_wait_for_network: inner tool "${innerTool}" not allowed (batch whitelist; no batch / await_human / recording / self)`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const ig = gateCheck(innerTool);
      if (ig) return ig;
      if (
        args.match.urlPattern === undefined &&
        args.match.method === undefined &&
        args.match.status === undefined
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "act_and_wait_for_network: `match` needs at least one of urlPattern / method / status",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const e = await entryFor(args.session);
      const timeout = args.timeoutMs ?? 10_000;
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      // arm the waiter BEFORE dispatching the action so a fast response can't slip past.
      const waitP = e.session
        .page()
        .waitForResponse(
          (r) =>
            matchesResponse(
              { url: r.url(), method: r.request().method(), status: r.status() },
              args.match,
            ),
          { timeout },
        )
        .then(
          (r) => ({
            matched: true as const,
            method: r.request().method(),
            url: sanitizeUrl(r.url()),
            status: r.status(),
          }),
          () => ({ matched: false as const }),
        );
      const innerArgs = { ...(args.action.args ?? {}), session: args.session };
      const [aRes, network] = await Promise.all([toolHandlers[innerTool]!(innerArgs), waitP]);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ action: parseInner(aRes), network }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "poll_eval",
    {
      description:
        "Repeatedly evaluate a JS expression in the page until it returns a truthy value or `timeoutMs` elapses — for waiting on async job completion / store updates without ad-hoc in-page loops (a long in-page promise would trip the anti-wedge deadline). The value is page-controlled — treat it as untrusted, like `eval_js`. Capability: `eval`. Returns `{ ok, truthy, value, polls, elapsedMs, timedOut }`.",
      inputSchema: {
        expr: z
          .string()
          .describe(
            "JS expression; must be JSON-serializable. Wrap statements in `(() => { … })()`.",
          ),
        intervalMs: z
          .number()
          .int()
          .min(50)
          .max(10_000)
          .optional()
          .describe("Poll interval (default 250, min 50)."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Total budget (default 5000)."),
        ...SESSION_ARG,
      },
    },
    async ({ expr, intervalMs, timeoutMs, session }) => {
      const g = gateCheck("poll_eval");
      if (g) return g;
      const s = (await entryFor(session)).session;
      const interval = intervalMs ?? 250;
      const budget = timeoutMs ?? 5000;
      const perPoll = Math.min(budget, 5000);
      const start = Date.now();
      let polls = 0;
      let value: unknown;
      while (Date.now() - start < budget) {
        polls++;
        try {
          value = await withDeadline(s.page().evaluate(expr), perPoll, "poll_eval");
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                    polls,
                    elapsedMs: Date.now() - start,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        if (value) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: true,
                    truthy: true,
                    value,
                    polls,
                    elapsedMs: Date.now() - start,
                    timedOut: false,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        if (Date.now() - start + interval >= budget) break;
        await new Promise((r) => setTimeout(r, interval));
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                truthy: false,
                value,
                polls,
                elapsedMs: Date.now() - start,
                timedOut: true,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
