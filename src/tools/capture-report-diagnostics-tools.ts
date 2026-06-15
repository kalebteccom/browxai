import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { sep as pathSep } from "node:path";
import { estimateTokens } from "../util/tokens.js";
import { resolveWorkspacePath } from "../session/storage.js";
import { DEFAULT_SESSION_ID } from "../session/registry.js";
import {
  buildReportSummary,
  type DiagnosticsRecord,
  type NoteCategory,
  type NoteSeverity,
} from "../util/diagnostics.js";
import {
  lowerTraceToSpec,
  parseCheck as parsePlaywrightSpec,
} from "../page/export-playwright-script.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/** Stamp the body with its token estimate and wrap it as a tool text response —
 *  the shared shape every `export_playwright_script` failure/early return uses. */
function exportScriptResult(body: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
} {
  const withTokens = { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) };
  return { content: [{ type: "text" as const, text: JSON.stringify(withTokens, null, 2) }] };
}

/** Filter a diagnostics record against the `diagnostics_search` query. The
 *  `tool` filter implies a `call` record; the `category` filter implies a `note`
 *  record (records of the other kind are excluded when either is set). */
function matchesDiagnosticFilter(
  r: DiagnosticsRecord,
  q: { sinceMs?: number; sessionId?: string; tool?: string; category?: string },
): boolean {
  if (q.sinceMs !== undefined && Date.parse(r.ts) < q.sinceMs) return false;
  if (q.sessionId && r.sessionId !== q.sessionId) return false;
  if (q.tool) {
    if (r.kind !== "call" || r.tool !== q.tool) return false;
  }
  if (q.category) {
    if (r.kind !== "note" || r.category !== q.category) return false;
  }
  return true;
}

/**
 * Capture + report — session report & the diagnostics store. The session report
 * + metrics rollups, the diagnostics note/search/report agent-feedback store,
 * and Playwright-script export. Registered through the shared `ToolHost` seam.
 */
export function registerCaptureReportDiagnosticsTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    workspace,
    registry,
    diagnostics,
  } = host;


  register(
    "export_session_report",
    {
      capability: "read",
      description:
        "Bundle a session's current QA evidence into one JSON object — url, console errors, recent network summary, named regions, live sessions — so multi-agent QA results are auditable without normalising each agent's notes by hand. `note` records a free-text label/summary. Returns the bundle (not written to disk).",
      inputSchema: {
        note: z.string().optional().describe("Free-text label / summary for this session's run."),
        ...SESSION_ARG,
      },
    },
    async ({ note, session }) => {
      const g = gateCheck("export_session_report");
      if (g) return g;
      const e = await entryFor(session);
      const net = e.network.recent(50);
      const report = {
        ok: true,
        session: e.id,
        mode: e.mode,
        url: e.session.page().url(),
        openedAt: new Date(e.openedAt).toISOString(),
        generatedAt: new Date().toISOString(),
        ...(note ? { note } : {}),
        consoleErrors: e.console
          .recent(200)
          .filter((m) => m.type === "error")
          .map((m) => m.text)
          .slice(-25),
        network: net.summary,
        regions: e.regions.list().map((r) => r.name),
        liveSessions: registry.list().map((s) => ({ id: s.id, mode: s.mode })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
    },
  );

  register(
    "session_metrics",
    {
      capability: "read",
      batchable: true,
      description:
        "Per-session cumulative tool-call metrics — counts, latency, `tokensEstimate` sum, capability denials, and per-tool error counts. Piggybacks on the existing per-call envelope data (no new instrumentation, no disk writes). Pairs with `export_session_report` (which bundles the session's QA EVIDENCE — url, console errors, recent network summary, named regions, live sessions); this one rolls up DISPATCH EVIDENCE so a consumer can audit which tools the agent leaned on, how token-expensive each got, and whether the agent kept hitting a capability gate that's off. Read-only (capability `read`). → `{ ok, session, callsByTool, durationMsByTool, errorsByTool, tokensEstimateSum, capabilityDenials, sessionStartedAt, sessionDurationMs, tokensEstimate }`.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("session_metrics");
      if (g) return g;
      const e = await entryFor(session);
      const snap = e.metrics.snapshot();
      const body = {
        ok: true as const,
        session: e.id,
        ...snap,
        tokensEstimate: 0,
      };
      body.tokensEstimate = estimateTokens(JSON.stringify(body));
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---------- diagnostics ----------

  register(
    "diagnostics_note",
    {
      capability: "diagnostics",
      description:
        "Agent self-feedback. File a structured insight against the diagnostics JSONL store: a missing primitive, a workaround that worked, a perf concern, or an ergonomic friction the curated tool surface didn't cover. `ref` optionally points at a prior tool call (a record id or `tool:ts` shorthand). The recorder is engaged by the same `diagnostics` capability — registering a note while the capability is OFF returns a structured refusal (so a polling agent on a server with diagnostics off doesn't silently lose feedback). Default category `other`, default severity `info`. Capability: `diagnostics`.",
      inputSchema: {
        insight: z
          .string()
          .min(1)
          .describe(
            "Free-text observation — what was tried, what was missing, what ergonomic friction surfaced.",
          ),
        category: z
          .enum(["missing-primitive", "workaround", "perf-concern", "ergonomic-friction", "other"])
          .optional()
          .describe(
            "Default `other`. `missing-primitive` is the most actionable bucket for the curator — surface when an `eval_js` pattern keeps recurring.",
          ),
        severity: z
          .enum(["info", "warn", "blocker"])
          .optional()
          .describe('Default `info`. `blocker` means "this stopped me completing the task".'),
        ref: z
          .string()
          .optional()
          .describe(
            "Optional reference to a prior record — e.g. `eval_js:2026-06-08T12:34:56.000Z` or a record id surfaced by `diagnostics_search`.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({
      insight,
      category,
      severity,
      ref,
      session,
    }: {
      insight: string;
      category?: NoteCategory;
      severity?: NoteSeverity;
      ref?: string;
      session?: string;
    }) => {
      const g = gateCheck("diagnostics_note");
      if (g) return g;
      const sessionId = session ?? DEFAULT_SESSION_ID;
      const record: DiagnosticsRecord = {
        kind: "note",
        ts: new Date().toISOString(),
        sessionId,
        insight,
        category: category ?? "other",
        severity: severity ?? "info",
        ...(ref ? { ref } : {}),
      };
      diagnostics.write(record);
      const body = {
        ok: true as const,
        session: sessionId,
        recorded: {
          kind: record.kind,
          ts: record.ts,
          category: record.category,
          severity: record.severity,
        },
        tokensEstimate: estimateTokens(JSON.stringify({ insight, category, severity, ref })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "diagnostics_search",
    {
      capability: "read",
      description:
        "Read-side query over the diagnostics JSONL store. Returns matching records — calls + notes — up to `limit` (default 100, max 1000). `since` filters by ts (ISO); `tool` filters by tool name (exact match); `category` filters notes only; `sessionId` filters by session. The recorder is gated on the `diagnostics` capability; this query reads whatever lives on disk, so a server with diagnostics OFF but a non-empty workspace history can still surface prior runs. Read-only (capability `read`). → `{ ok, records, count, truncated }`.",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("ISO timestamp filter — only records with `ts >= since` are returned."),
        tool: z
          .string()
          .optional()
          .describe('Tool-name filter (exact match) — applies to `kind:"call"` records only.'),
        category: z
          .string()
          .optional()
          .describe('Note-category filter — applies to `kind:"note"` records only.'),
        sessionId: z.string().optional().describe("Session-id filter."),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Max records to return. Default 100, hard cap 1000."),
        ...SESSION_ARG,
      },
    },
    async ({
      since,
      tool,
      category,
      sessionId,
      limit,
      session: _session,
    }: {
      since?: string;
      tool?: string;
      category?: string;
      sessionId?: string;
      limit?: number;
      session?: string;
    }) => {
      const g = gateCheck("diagnostics_search");
      if (g) return g;
      const lim = limit ?? 100;
      const sinceMs = since ? Date.parse(since) : undefined;
      const matched: DiagnosticsRecord[] = [];
      let truncated = false;
      for (const r of diagnostics.readAll()) {
        if (!matchesDiagnosticFilter(r, { sinceMs, sessionId, tool, category })) continue;
        if (matched.length >= lim) {
          truncated = true;
          break;
        }
        matched.push(r);
      }
      const body = {
        ok: true as const,
        records: matched,
        count: matched.length,
        truncated,
        tokensEstimate: 0,
      };
      body.tokensEstimate = estimateTokens(JSON.stringify(body));
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "diagnostics_report",
    {
      capability: "read",
      description:
        "Analysis primitive over the diagnostics JSONL store. `summary` (default) returns per-tool counts + p50/p95 durations, the top 10 eval_js patterns by count + their taxonomy classification, capability-denial counts, note counts by category, and a `missingPrimitiveHypotheses` list — eval_js taxonomy buckets with high count flagged as candidates for a curated primitive (heuristic: non-`custom` taxonomy with count ≥ 3 OR `custom` pattern with count ≥ 5). `full` returns the same + a per-record stream capped at 500 records (`truncated:true` when exceeded). Optional `since` (ISO) windowing + `sessionId` filter. Read-only (capability `read`).",
      inputSchema: {
        format: z
          .enum(["summary", "full"])
          .optional()
          .describe(
            "Default `summary`. `full` additionally streams the per-record list (capped at 500).",
          ),
        since: z
          .string()
          .optional()
          .describe("ISO timestamp filter — only records with `ts >= since` are aggregated."),
        sessionId: z.string().optional().describe("Restrict the rollup to one session id."),
        ...SESSION_ARG,
      },
    },
    async ({
      format,
      since,
      sessionId,
      session: _session,
    }: {
      format?: "summary" | "full";
      since?: string;
      sessionId?: string;
      session?: string;
    }) => {
      const g = gateCheck("diagnostics_report");
      if (g) return g;
      const fmt = format ?? "summary";
      const all = diagnostics.readAll();
      const summary = buildReportSummary(all, { since, session: sessionId });
      let records: DiagnosticsRecord[] | undefined;
      let truncated = false;
      if (fmt === "full") {
        const CAP = 500;
        const sinceMs = since ? Date.parse(since) : undefined;
        records = [];
        for (const r of all) {
          if (sinceMs !== undefined && Date.parse(r.ts) < sinceMs) continue;
          if (sessionId && r.sessionId !== sessionId) continue;
          if (records.length >= CAP) {
            truncated = true;
            break;
          }
          records.push(r);
        }
      }
      const body = {
        ok: true as const,
        format: fmt,
        summary,
        ...(records ? { records, truncated } : {}),
        tokensEstimate: 0,
      };
      body.tokensEstimate = estimateTokens(JSON.stringify(body));
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "export_playwright_script",
    {
      capability: "read",
      description:
        "Lower a session's recorded action trace into a runnable `@playwright/test` spec file. Adjacent to `export_session_report` (which bundles QA evidence) and to `end_recording` (which emits the site-docs flow-file YAML); this one emits a `.spec.ts` source a code-as-action consumer can run as the seed for a skill-compilation loop. Each recorded step lowers to ONE Playwright call using the BEST stable `selectorHint` captured at the time of the call (tier-1 attribute → `page.locator(...)`, tier-2 role+name → `getByRole({name})`, role-only / tier-5 → `getByRole()` with a `// TODO: fragile selector` comment). Coords-mode actions are not recorded so the export never has to lower a non-replayable target. Requires an ACTIVE recording (call `start_recording` first); inspect-style — does NOT end the recording. With `path`, ALSO writes to a workspace-rooted `.spec.ts` file (path-traversal rejected — must resolve under $BROWX_WORKSPACE). Read-only (capability `read`). Returns `{ ok, name, source, path?, stats:{steps,handled,unhandled,fragile}, tokensEstimate }`.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Optional workspace-rooted file path to write the `.spec.ts` to (in addition to returning it inline). Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ path, session }) => {
      const g = gateCheck("export_playwright_script");
      if (g) return g;
      const e = await entryFor(session);
      const snap = e.recorder.inspect();
      if (!snap) {
        return exportScriptResult({
          ok: false,
          tool: "export_playwright_script",
          error:
            "no active recording — call `start_recording({flowName})` first, " +
            "drive the flow with the usual action tools (navigate/click/fill/..." +
            "), then call this. The recording is NOT ended by export — `end_recording` " +
            "still emits the YAML flow-file separately.",
          failure: { source: "browxai", hint: "start_recording before exporting" },
        });
      }
      const lowered = lowerTraceToSpec(snap.name, snap.steps);
      const check = parsePlaywrightSpec(lowered.source);
      if (!check.ok) {
        return exportScriptResult({
          ok: false,
          tool: "export_playwright_script",
          error: `generated spec failed the structural parse-check: ${check.reason}`,
          source: lowered.source,
          stats: lowered.stats,
        });
      }
      let writtenPath: string | undefined;
      let writtenBytes: number | undefined;
      if (path !== undefined) {
        try {
          const resolved = resolveWorkspacePath(workspace.root, path, "export_playwright_script");
          // Ensure parent dir exists — same pattern dumpStorageState uses.
          const parent = resolved.substring(0, Math.max(resolved.lastIndexOf(pathSep), 0));
          if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
          writeFileSync(resolved, lowered.source, "utf8");
          writtenPath = resolved;
          writtenBytes = Buffer.byteLength(lowered.source, "utf8");
        } catch (err) {
          return exportScriptResult({
            ok: false,
            tool: "export_playwright_script",
            error: err instanceof Error ? err.message : String(err),
            source: lowered.source,
            stats: lowered.stats,
          });
        }
      }
      const body: {
        ok: true;
        name: string;
        source: string;
        stats: typeof lowered.stats;
        path?: string;
        bytes?: number;
        tokensEstimate: number;
      } = {
        ok: true,
        name: snap.name,
        source: lowered.source,
        stats: lowered.stats,
        ...(writtenPath ? { path: writtenPath, bytes: writtenBytes } : {}),
        tokensEstimate: 0,
      };
      body.tokensEstimate = estimateTokens(JSON.stringify(body));
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );
}
