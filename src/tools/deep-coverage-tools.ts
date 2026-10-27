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
        "Start precise JS and CSS coverage on this session (CDP `Profiler.startPreciseCoverage` and `CSS.startRuleUsageTracking`), to find JS and CSS that ships but never runs. Read the result with `coverage_stop`. One tracker per session: calling `coverage_start` while one runs stops it (results discarded) and restarts. `perf_audit` uses this internally; call these two directly only for the raw report or a longer window than `perf_audit` takes.",
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
        "Stop coverage tracking and return the parsed report: `{ok, jsCoverage:[{url, totalBytes, usedBytes, usagePercent, deadRanges?}], cssCoverage:[{url, totalBytes, usedBytes, usedRules, totalRules, usagePercent, deadRules?}], durationMs}`. `usagePercent` under 30 means a lot of dead code (the `unused-code` analyser flags it); `deadRanges` and `deadRules` hold the top 50 per file. With no tracker running it returns `notRunning:true`. Nothing is written to disk.",
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
        'Record a CDP trace for `durationMs` (default 5000, max 30000) that captures forced synchronous layouts, layout shifts and style recalculations, then group them by originating call stack, so you see "this rAF loop fired 200 forced layouts" without paging through a huge trace. Returns `{ok, forcedLayoutsCount, layoutShiftsCount, eventsByOrigin:[{originatingStack, count, totalDurationMs}], tracePath, durationMs}`, top 50 origins by count. `originatingStack` is `"<anonymous>"` when the event has no stack (Chromium adds stacks when DevTools is attached). `tracePath` is `<workspace>/perf/<sessionId>-layout-thrash-<ts>.json`, loadable in DevTools\' Performance panel.',
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
        "Diff two V8 heap snapshots (`.heapsnapshot` paths from `heap_snapshot`) and report retainer growth per node-type group. Pure file work: it does not touch the browser. `beforePath` and `afterPath` must resolve inside `$BROWX_WORKSPACE`. Returns `{ok, retainerGrowth:[{node, type, sizeBefore, sizeAfter, deltaBytes, deltaPercent}], summary:{totalGrowth, top3Growers}}`, sorted by `deltaBytes` descending, max 100 rows, groups under 1024 bytes of change dropped. `node` is the V8 `${type}:${name}` label, as in `heap_retainers`. Typical leak check: `heap_snapshot`, run the suspect interaction, `heap_snapshot`, then `memory_diff`. The `leak-suspects` analyser of `perf_audit` consumes this shape.",
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
        "Take a V8 heap snapshot of this session's target (CDP `HeapProfiler.takeHeapSnapshot`), to diagnose memory leaks: pair it with `heap_retainers({snapshotPath, query})` to ask who still points at objects of a given name or type, which `snapshot` and `find` cannot show because leaked nodes are no longer in the DOM. One snapshot per call. Default path `<workspace>/heap-snapshots/<sessionId>-<ts>.heapsnapshot`; `path` must resolve inside `$BROWX_WORKSPACE`. The file opens in DevTools' Memory panel. Snapshots are heavy (tens to hundreds of MiB on a real page): do not take them in a loop.",
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
        'Run a retainer query against a `.heapsnapshot` file and return the top 50 retainers (by retainer self-size, descending) of the nodes whose name or V8 type matches. Answers "who is holding these objects alive?". File read only; no browser is touched. `query.name` is an exact match against the node\'s string-table name by default (`nameMatch:"substring"` for containment); `query.type` filters by V8 node type (`"closure"`, `"object"`, `"hidden"`, and so on). At least one of `name` and `type` is required. `snapshotPath` must resolve inside `$BROWX_WORKSPACE`. Any `.heapsnapshot` works, including one saved from DevTools or CI.',
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
