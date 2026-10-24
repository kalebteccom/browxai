import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { sep as pathSep } from "node:path";
import { estimateTokens } from "../util/tokens.js";
import { sanitizeUrl } from "../util/url-sanitizer.js";
import { resolveWorkspaceWritePath as writePath } from "../session/storage.js";
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
import { engineDeclares } from "../engine/index.js";
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
  const { z, register, gateCheck, entryFor, workspace, registry, diagnostics, targetFor } = host;

  register(
    "export_session_report",
    {
      capability: "read",
      description:
        "Bundle the session's current QA evidence into one JSON object: url (query string, fragment and userinfo removed, as in `network_read`), console errors, recent network summary, named regions and live sessions, so results from several agents can be compared without normalising notes. `note` adds a free-text label. Returns the bundle and writes no file. Use `session_metrics` for tool-call counts and `export_playwright_script` for a runnable spec.",
      inputSchema: {
        note: z.string().optional().describe("Free-text label / summary for this session's run."),
        ...SESSION_ARG,
      },
    },
    async ({ note, session }) => {
      const g = gateCheck("export_session_report");
      if (g) return g;
      const e = await entryFor(session);
      // The network summary is a CLAIM about what the session observed, and this
      // bundle is the QA-evidence surface a human signs off on. An engine that
      // declares no `network` sub-interface has no protocol-level tap, so its ring
      // is permanently empty and `summary.total: 0` would read as "no traffic
      // occurred" when the truth is "nothing was watching". Declaration-keyed
      // (RFC 0004 D5): the field is replaced by a named absence, never a plausible
      // zero. Same defect class the `verify_*` family had. (RFC 0009.)
      const observesNetwork = engineDeclares(e.session.engine, "network");
      const net = observesNetwork ? e.network.recent(50) : null;
      // Link the most-recent completed .browx replay when the session ran one.
      // Absent when no recording ever engaged the writer (the artifact is the
      // sensitive companion of this evidence bundle — the description repeats
      // that so a downstream consumer sees the caveat too).
      const lastReplay = e.replay?.lastArtifact?.();
      const report = {
        ok: true,
        session: e.id,
        mode: e.mode,
        // Same URL redaction `network_read` and `console_read` apply.
        url: sanitizeUrl(await targetFor(e).url()),
        openedAt: new Date(e.openedAt).toISOString(),
        generatedAt: new Date().toISOString(),
        ...(note ? { note } : {}),
        consoleErrors: e.console
          .recent(200)
          .filter((m) => m.type === "error")
          .map((m) => m.text)
          .slice(-25),
        ...(net
          ? { network: net.summary }
          : {
              networkUnavailable:
                `the "${e.session.engine}" engine declares no "network" sub-interface — it ` +
                "cannot observe protocol-level traffic, so this report carries no network " +
                "summary. Absence of the field means the check was not performed; it does " +
                "NOT mean no requests were made.",
            }),
        regions: e.regions.list().map((r) => r.name),
        liveSessions: registry.list().map((s) => ({ id: s.id, mode: s.mode })),
        ...(lastReplay ? { replayArtifact: lastReplay } : {}),
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
        "Per-session cumulative tool-call metrics: calls, latency, `tokensEstimate` sum, capability denials and error counts per tool. It reads data the server already keeps (no new instrumentation, no disk writes). Use it to see which tools an agent leaned on, what they cost in tokens, and whether it kept hitting a capability that is off; `export_session_report` bundles the page's QA evidence instead. Returns `{ ok, session, callsByTool, durationMsByTool, errorsByTool, tokensEstimateSum, capabilityDenials, sessionStartedAt, sessionDurationMs, tokensEstimate }`.",
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
        "File a structured note in the diagnostics store: a missing primitive, a workaround that worked, a performance concern, or an ergonomic problem the tool surface did not cover. `ref` optionally points at an earlier tool call (a record id or `tool:ts`). Requires the `diagnostics` capability (off by default); while it is off the call returns a structured refusal, so a note is not lost without notice. The other optional fields have defaults (see their descriptions).",
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
        "Query the diagnostics store (tool calls and notes), returning up to `limit` records (default 100, max 1000). Filters: `since` (ISO timestamp), `tool` (exact name), `category` (notes only) and `sessionId`. It reads whatever is on disk, so a server with diagnostics off still shows earlier runs. Use `diagnostics_report` for aggregates. Returns `{ ok, records, count, truncated }`.",
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
        "Aggregate the diagnostics store. `summary` (default) returns per-tool counts with p50 and p95 durations, the ten most common `eval_js` patterns with their taxonomy class, capability-denial counts, note counts by category, and `missingPrimitiveHypotheses` (taxonomy classes with a high `eval_js` count that point to a missing primitive: a non-`custom` class with count 3 or more, or a `custom` pattern with count 5 or more). `full` adds a per-record stream capped at 500 (`truncated:true` past that). `since` (ISO) and `sessionId` narrow the window. Use `diagnostics_search` for individual records.",
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
        "Turn the session's recorded action trace into a runnable `@playwright/test` spec. It needs an active recording (`start_recording` first) and does not end it; `end_recording` returns the flow-file YAML instead and `export_session_report` bundles QA evidence. Each recorded action becomes one Playwright call using the best selectorHint captured (testid attribute, then role and name, then role only with a `// TODO: fragile selector` comment). Actions that used `coords` are not recorded. Recorded reads lower too: `extract` to a per-field re-read (fields using the property-name rule emit `null` and a TODO), `find` to a named locator, `eval_js` to `page.evaluate` of the recorded expression, `snapshot` to a comment. With `path` it also writes a workspace-rooted `.spec.ts`; a path outside $BROWX_WORKSPACE is rejected. Returns `{ ok, name, source, path?, stats:{steps,handled,unhandled,fragile}, tokensEstimate }`.",
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
          const resolved = writePath(workspace.root, path, "export_playwright_script");
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
