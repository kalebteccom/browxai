import { requireCdp } from "../engine/index.js";
import { estimateTokens } from "../util/tokens.js";
import { runLayoutThrashTrace } from "../page/layout-thrash.js";
import { diffHeapSnapshots } from "../page/memory-diff.js";
import {
  takeHeapSnapshot,
  defaultHeapSnapshotPath,
  writeHeapSnapshotFile,
  readHeapSnapshotFile,
  queryRetainers,
} from "../page/heap.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Deep tools — coverage, layout-thrash, and V8 heap. `coverage_start` /
 * `coverage_stop`, `layout_thrash_trace`, `memory_diff`, `heap_snapshot`, and
 * `heap_retainers`. All CDP-deep (refused off Chromium). Registered through the
 * shared `ToolHost` seam.
 */
export function registerDeepCoverageTools(host: ToolHost): void {
  const { z, register, gateCheck, engineGate, entryFor, workspace } = host;

  register(
    "coverage_start",
    {
      capability: "action",
      batchable: true,
      deep: true,
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
      capability: "read",
      batchable: true,
      deep: true,
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
      capability: "read",
      batchable: true,
      deep: true,
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
      capability: "read",
      batchable: true,
      deep: true,
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
      capability: "action",
      batchable: true,
      deep: true,
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
      capability: "action",
      batchable: true,
      deep: true,
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
}
