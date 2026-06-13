import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { sep as pathSep } from "node:path";
import { requireCdp } from "../engine/index.js";
import { confirmByobAction } from "../policy/confirm.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { screenshotMarks, type MarkCandidate } from "../page/set-of-marks.js";
import { sampleMetric, ELEMENT_METRICS } from "../page/sample.js";
import { uploadFile } from "../page/upload.js";
import { dropFiles, type DropFileInput } from "../page/drop-files.js";
import { readCapturedBytes } from "../page/downloads.js";
import { assetExport } from "../page/asset-export.js";
import { pdfSave, assertPdfSupported } from "../page/pdf.js";
import { pageArchive } from "../page/archive.js";
import { elementExportFromRef } from "../page/element-export.js";
import { domExport } from "../page/dom-export.js";
import { detectOverflow } from "../page/overflow-detect.js";
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
import { REF_OR_SELECTOR, SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Capture + report tools — the artefact-egress and evidence family: region
 * screenshots and set-of-marks composition, named-region binding/resolution,
 * cross-session sampling, session report + metrics rollups, the diagnostics
 * note/search/report store, Playwright-script export, file upload / drop,
 * download capture/read, asset/PDF/page/element/DOM export, and overflow
 * detection. Every block is registered through the shared `ToolHost` seam; the
 * host owns the closures (gate, ctx, ports), this module owns the registrations.
 */
export function registerCaptureReportTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    engineGate,
    entryFor,
    confirmCtxFor,
    denyContent,
    asTarget,
    cfgActionTimeout,
    workspace,
    config,
    toolHandlers,
    registry,
    diagnostics,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
  } = host;

  const BOX_SCHEMA = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  });

  register(
    "screenshot_region",
    {
      description:
        "PNG screenshot of an arbitrary viewport rectangle (not an element) — for virtualised timelines / canvas / unlabelled positioned regions where an element-cropped shot doesn't apply.",
      inputSchema: {
        box: BOX_SCHEMA.describe("Viewport rect {x,y,width,height} in CSS px."),
        ...SESSION_ARG,
      },
    },
    async ({ box, session }) => {
      const g = gateCheck("screenshot_region");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const buf = await withDeadline(
          e.session.page().screenshot({ clip: box, type: "png" }),
          cfgActionTimeout(),
          "screenshot_region",
        );
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(buf).toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "screenshot_marks",
    {
      description:
        'Composed PNG with numbered bounding boxes painted over caller-supplied candidates — the set-of-marks primitive multimodal agents reach for when they want to ground a vision read against a small palette of stable refs ("click 2" instead of estimating a coordinate). Each candidate is either a bare `{ref}` (looked up against the current snapshot for its bbox) OR a full `find()` candidate row passed through (`{ref, role, name, testId, bbox}` — fast path, no extra tree walk). `label:"index"` (default) paints 1..N positions paired with an `{index→ref}` mapping; `label:"ref"` paints the existing `eN` directly; `label:"role"` paints the role for visual grounding. The numbering scheme SHARES the existing `name_ref` / `eN` namespace — no parallel ID space — so `mapping["2"] === "e7"` and the agent can address either way. Pure compose on top of `find()` / `snapshot()` (no new browser interaction beyond a transient in-page overlay removed before return). Candidates with `bbox:null` (clipped / off-screen) are kept in `marks` with `painted:false` so the mapping stays complete. Read-only (`read`).',
      inputSchema: {
        candidates: z
          .array(z.union([z.object({ ref: z.string() }).passthrough(), z.object({}).passthrough()]))
          .min(1)
          .max(50)
          .describe(
            "Either `{ref}` rows (looked up against the current snapshot for bbox) OR full find() candidate rows (passed through). Mix-and-match allowed. Cap 50.",
          ),
        label: z
          .enum(["index", "ref", "role"])
          .optional()
          .describe(
            "How to label each painted box. `index` (default) = 1..N array position, paired with the `{index→ref}` mapping in the result. `ref` = paint the existing `eN` ref directly. `role` = paint the candidate's role.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("screenshot_marks");
      if (g) return g;
      const e = await entryFor(args.session);
      const candidates = args.candidates as unknown as MarkCandidate[];
      try {
        const result = await withDeadline(
          screenshotMarks(
            e.session.page(),
            e.snapshotSubstrate,
            e.refs,
            {
              candidates,
              label: args.label,
              testAttributes: config.testAttributes,
            },
            e.session.cdp ? e.session.cdp() : undefined,
          ),
          cfgActionTimeout(),
          "screenshot_marks",
        );
        const content: Array<
          { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
        > = [
          {
            type: "text",
            text: JSON.stringify(
              { marks: result.marks, mapping: result.mapping, warnings: result.warnings },
              null,
              2,
            ),
          },
          { type: "image", data: result.imageBase64, mimeType: result.mimeType },
        ];
        return { content };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "name_region",
    {
      description:
        "Bind a viewport rectangle to a mnemonic so a sub-agent can re-select the same media segment / timeline row without re-deriving coordinates (drift). Resolve it later with `region`. Per-session.",
      inputSchema: {
        name: z.string().describe('Mnemonic, e.g. "matching_audio_clip".'),
        box: BOX_SCHEMA,
        ...SESSION_ARG,
      },
    },
    async ({ name, box, session }) => {
      const g = gateCheck("name_region");
      if (g) return g;
      const e = await entryFor(session);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, ...e.regions.set(name, box) }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "region",
    {
      description:
        "Resolve a `name_region` mnemonic to its `{ box, center }`. Pass `center` to a coords-based action (`click({coords})`) to act on the bound region.",
      inputSchema: { name: z.string(), ...SESSION_ARG },
    },
    async ({ name, session }) => {
      const g = gateCheck("region");
      if (g) return g;
      const e = await entryFor(session);
      const r = e.regions.get(name);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              r
                ? { ok: true, ...r }
                : {
                    ok: false,
                    error: `no region named "${name}" — call name_region first`,
                    known: e.regions.list().map((x) => x.name),
                  },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  register(
    "cross_session_sample",
    {
      description:
        "Drive an action in one session and sample a metric in ANOTHER over the same window, in one call — for realtime-propagation assertions (an action in session A should reflect in session B within a freshness budget). `action` is `{tool,args}` from the batch whitelist, dispatched in `actionSession`; the document-scroller `metric` is traced in `sampleSession`. Returns `{ action: <inner result>, sample }`.",
      inputSchema: {
        action: z.object({ tool: z.string(), args: z.record(z.unknown()).optional() }),
        actionSession: z.string().describe("Session the action runs in."),
        sampleSession: z.string().describe("Session whose page is sampled."),
        metric: z
          .enum(ELEMENT_METRICS)
          .describe("Fixed metric (document scroller of sampleSession)."),
        durationMs: z.number().int().positive().max(30_000),
        everyFrame: z.boolean().optional(),
        intervalMs: z.number().int().positive().max(5000).optional(),
      },
    },
    async (args) => {
      const g = gateCheck("cross_session_sample");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "cross_session_sample") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `cross_session_sample: inner tool "${innerTool}" not allowed (batch whitelist; no batch / await_human / recording / self)`,
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
      const sampleEntry = await entryFor(args.sampleSession);
      const samplePromise = sampleMetric(sampleEntry.session.page(), sampleEntry.refs, {
        metric: args.metric,
        durationMs: args.durationMs,
        everyFrame: args.everyFrame,
        intervalMs: args.intervalMs,
      });
      const innerArgs = { ...(args.action.args ?? {}), session: args.actionSession };
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      const [sRes, aRes] = await Promise.allSettled([
        samplePromise,
        toolHandlers[innerTool]!(innerArgs),
      ]);
      const sample =
        sRes.status === "fulfilled"
          ? sRes.value
          : { error: sRes.reason instanceof Error ? sRes.reason.message : String(sRes.reason) };
      const action =
        aRes.status === "fulfilled"
          ? parseInner(aRes.value)
          : {
              ok: false,
              error: aRes.reason instanceof Error ? aRes.reason.message : String(aRes.reason),
            };
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ action, sample }, null, 2) }],
      };
    },
  );

  register(
    "export_session_report",
    {
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
      const all = diagnostics.readAll();
      const matched: DiagnosticsRecord[] = [];
      let truncated = false;
      for (const r of all) {
        if (sinceMs !== undefined && Date.parse(r.ts) < sinceMs) continue;
        if (sessionId && r.sessionId !== sessionId) continue;
        if (tool && r.kind === "call" && r.tool !== tool) continue;
        if (tool && r.kind !== "call") continue;
        if (category && r.kind === "note" && r.category !== category) continue;
        if (category && r.kind !== "note") continue;
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
        const body = {
          ok: false,
          tool: "export_playwright_script",
          error:
            "no active recording — call `start_recording({flowName})` first, " +
            "drive the flow with the usual action tools (navigate/click/fill/..." +
            "), then call this. The recording is NOT ended by export — `end_recording` " +
            "still emits the YAML flow-file separately.",
          failure: { source: "browxai", hint: "start_recording before exporting" },
          tokensEstimate: 0,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      }
      const lowered = lowerTraceToSpec(snap.name, snap.steps);
      const check = parsePlaywrightSpec(lowered.source);
      if (!check.ok) {
        const body = {
          ok: false,
          tool: "export_playwright_script",
          error: `generated spec failed the structural parse-check: ${check.reason}`,
          source: lowered.source,
          stats: lowered.stats,
          tokensEstimate: 0,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
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
          const body = {
            ok: false,
            tool: "export_playwright_script",
            error: err instanceof Error ? err.message : String(err),
            source: lowered.source,
            stats: lowered.stats,
            tokensEstimate: 0,
          };
          body.tokensEstimate = estimateTokens(JSON.stringify(body));
          return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
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

  register(
    "upload_file",
    {
      description:
        "Set a file on a file `<input>` (works on hidden inputs) via Playwright `setInputFiles` — the first-class alternative to injecting `File`/`DataTransfer` through `eval_js`. Target the input by `ref`/`selector`. File source is exactly one of: `content` (base64 inline — no filesystem read; pass `name`/`mimeType`) OR `path` (resolved **inside `$BROWX_WORKSPACE` only** — a path escaping the workspace is rejected; stage the file there). Gated by the off-by-default **`file-io`** capability.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        name: z
          .string()
          .optional()
          .describe('Filename presented to the page (content-mode; default "upload").'),
        mimeType: z
          .string()
          .optional()
          .describe("MIME type (content-mode; default application/octet-stream)."),
        content: z
          .string()
          .optional()
          .describe("base64 file content. Mutually exclusive with `path`."),
        path: z
          .string()
          .optional()
          .describe("Workspace-rooted file path. Mutually exclusive with `content`."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("upload_file");
      if (g) return g;
      const e = await entryFor(args.session);
      const c = await confirmByobAction("upload_file", confirmCtxFor(e));
      if (!c.ok) return denyContent("upload_file", c);
      try {
        const target = asTarget(args, "upload_file", e.refs);
        if ("coords" in target) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error:
                      "upload_file: target must be a ref/selector for the file input, not coords",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const r = await withDeadline(
          uploadFile(e.session.page(), e.refs, workspace.root, {
            target,
            name: args.name,
            mimeType: args.mimeType,
            content: args.content,
            path: args.path,
          }),
          cfgActionTimeout(),
          "upload_file",
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `drop_files` — sibling to `upload_file` for drop-zone uploaders. Modern
  // SaaS file pickers listen for `dragenter`/`dragover`/`drop` with a
  // populated `DataTransfer.files` and never expose an `<input type=file>` —
  // `setInputFiles` can't drive them. drop_files synthesizes the standard
  // HTML5 drop sequence with `File` objects built in-page from the bytes the
  // caller supplies (`path` mode reads from $BROWX_WORKSPACE; `contents`
  // mode is inline base64). Same `file-io` capability as upload_file.
  register(
    "drop_files",
    {
      description:
        "Synthesize an HTML5 file drag-drop on a page element — the first-class alternative to driving DataTransfer through `eval_js` for drop-zone uploaders that don't expose an `<input type=file>` (modern SaaS file pickers). Target via the standard target shapes (`ref`/`selector`/`named`/`coords`). `files[]` carries one or more file entries; each entry is exactly one of: `{path, name?, mimeType?}` (workspace-rooted file — escape-rejected, same posture as `upload_file`'s `path`) OR `{contents, name, mimeType?}` (base64 inline — no filesystem read). Builds an in-page `DataTransfer` populated with `File` objects and dispatches `dragenter` → `dragover` → `drop` on the target with realistic `clientX`/`clientY` (element box centre for ref/selector; literal coords). Drops every file in a single sequence — passing multiple entries simulates the multi-file drop most uploaders support natively. → `{ ok, target, files: [{name, mode, bytes, mimeType}], totalBytes, fileCount, eventsFired, dropDispatched, tokensEstimate }`. Gated by the off-by-default **`file-io`** capability.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        files: z
          .array(
            z.object({
              path: z
                .string()
                .optional()
                .describe("Workspace-rooted file path. Mutually exclusive with `contents`."),
              contents: z
                .string()
                .optional()
                .describe("base64 file content. Mutually exclusive with `path`."),
              name: z
                .string()
                .optional()
                .describe(
                  "Filename presented to the page. Required in `contents`-mode; defaults to the basename of `path` in `path`-mode.",
                ),
              mimeType: z
                .string()
                .optional()
                .describe('MIME type. Default "application/octet-stream".'),
            }),
          )
          .min(1)
          .describe(
            "Files to drop. Each entry is exactly one of `{path}` or `{contents}` (plus optional `name`/`mimeType`).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("drop_files");
      if (g) return g;
      const e = await entryFor(args.session);
      const c = await confirmByobAction("drop_files", confirmCtxFor(e));
      if (!c.ok) return denyContent("drop_files", c);
      try {
        const target = asTarget(args, "drop_files", e.refs);
        const r = await withDeadline(
          dropFiles(e.session.page(), e.refs, workspace.root, {
            target,
            files: args.files as DropFileInput[],
          }),
          cfgActionTimeout(),
          "drop_files",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // Download capture — the reverse of `upload_file`. Off by default per
  // session; toggled by `downloads_capture`. When on, any download fired
  // during a subsequent action lands on `ActionResult.downloads[]` and can
  // be read back via `download_get`. Workspace-rooted paths only.
  register(
    "downloads_capture",
    {
      description:
        "Per-session download capture — toggle interception of Playwright `download` events. When `on:true`, every download fired during a subsequent action is persisted to `$BROWX_WORKSPACE/.downloads/<sessionId>/<prefix>-<sanitised-name>` and surfaced on `ActionResult.downloads[{id, suggestedFilename, mimeType, sizeBytes, path}]`. When `on:false` (the default) the artifact is silently discarded so a session that never opted in leaves no on-disk trace. The page-supplied filename is sanitised (no path separators / NULs / leading dots / control bytes; length-capped) before composing the on-disk name — workspace-escape rejected. Read captured bytes with `download_get({id})`. Gated by the off-by-default **`file-io`** capability — same posture as `upload_file`. → `{ ok, captureOn, storageDir, captured: [{id, suggestedFilename, sizeBytes, path, mimeType?}], tokensEstimate }`. Pass `clear:true` alongside `on:false` to ALSO delete every captured file on disk.",
      inputSchema: {
        on: z.boolean().describe("Turn capture on (true) or off (false). Off by default."),
        clear: z
          .boolean()
          .optional()
          .describe(
            "When toggling off, also delete every previously-captured file from disk. No-op when `on:true`.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("downloads_capture");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        e.downloads.captureOn = !!args.on;
        if (!args.on && args.clear) {
          // best-effort cleanup of previously-captured files. Every entry's
          // `path` is rooted under BROWX_WORKSPACE/.downloads/<sessionId>/
          // by construction (see SessionEntry factory + page/downloads.ts).
          const { unlinkSync } = await import("node:fs");
          for (const d of e.downloads.list()) {
            try {
              unlinkSync(d.path);
            } catch {
              /* best-effort */
            }
          }
        }
        const captured = e.downloads.list().map((d) => {
          const out: {
            id: string;
            suggestedFilename: string;
            sizeBytes: number;
            path: string;
            mimeType?: string;
          } = {
            id: d.id,
            suggestedFilename: d.suggestedFilename,
            sizeBytes: d.sizeBytes,
            path: d.path,
          };
          if (d.mimeType !== undefined) out.mimeType = d.mimeType;
          return out;
        });
        const body = {
          ok: true,
          captureOn: e.downloads.captureOn,
          storageDir: e.downloads.storageDir,
          captured,
        };
        const json = JSON.stringify(body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...body, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "download_get",
    {
      description:
        "Return the bytes (base64) of a previously-captured download. Pass the `id` from `ActionResult.downloads[]` (or `downloads_capture({on:true}).captured[]`). Set `pathOnly:true` to skip the base64 payload and return just the workspace-rooted path metadata (useful for very large artifacts an agent only needs to forward to another tool by path). → `{ ok, id, suggestedFilename, mimeType?, sizeBytes, path, content?: base64, tokensEstimate }`. Gated by the off-by-default **`file-io`** capability.",
      inputSchema: {
        id: z.string().describe("Download id from ActionResult.downloads[].id."),
        pathOnly: z
          .boolean()
          .optional()
          .describe("When true, omit the base64 `content` field and return only path/metadata."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("download_get");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = readCapturedBytes(e.downloads, args.id);
        const body: Record<string, unknown> = {
          ok: true,
          id: args.id,
          suggestedFilename: r.suggestedFilename,
          sizeBytes: r.bytes,
          path: r.path,
        };
        if (r.mimeType !== undefined) body.mimeType = r.mimeType;
        if (!args.pathOnly) body.content = r.base64;
        const json = JSON.stringify(body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...body, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `asset_export` — filter the session's network ring and persist matching
  // responses to a workspace-rooted dir. Mirrors `download_get`'s file-io
  // posture (read session-buffered state, write bytes under $BROWX_WORKSPACE).
  // CORS caveat: when a response body has aged out of the renderer cache the
  // tool falls back to an in-page `fetch()` against the original URL —
  // cross-origin URLs without permissive CORS headers will land in
  // `droppedCount`, not a crash.
  register(
    "asset_export",
    {
      description:
        'Filter every resource the session has loaded (the always-on `NetworkBuffer` ring) and persist matching responses to a workspace-rooted directory — the first-class alternative to scraping `<img src>` / `<link href>` then re-fetching each one through `eval_js`. Filter shape: `{mime?: string[], urlPattern?: string, minBytes?: number, maxBytes?: number, status?: number[]}`. `mime` is substring match against the captured response `Content-Type` (case-insensitive, any one match wins; e.g. `["image/", "video/"]`). `urlPattern` is a RegExp source matched case-insensitively against the URL (e.g. `"\\\\.(woff2?|ttf|otf)$"`). `minBytes`/`maxBytes` bound the encoded response size when known. `status` defaults to 2xx (200..299). Filenames are derived from the URL path basename, **sanitised** (no path separators / NULs / leading dots / control bytes; length-capped), and collision-resolved with `-N` suffix. `intoDir` defaults to `$BROWX_WORKSPACE/assets/<sessionId>-<ISO>/`; an explicit value is resolved INSIDE `$BROWX_WORKSPACE` (escape rejected). Per-call caps: `maxCount` (default 10000) + `maxBytes` (default 500 MiB) bound runaway exports — callers can raise both up to hard ceilings. **CORS caveat**: when the response body has been discarded by the renderer (bodies are short-lived) the tool falls back to an in-page `fetch()` against the original URL — cross-origin URLs without permissive CORS headers land in `droppedCount`, never a crash. → `{ ok, intoDir, totalCount, matchedCount, persistedCount, droppedCount, manifest: [{url, mime?, status?, sizeBytes, savedAs}], warnings, tokensEstimate }`. The manifest is also written to `<intoDir>/_manifest.json`. `tokensEstimate` sizes the result envelope (the manifest blob), NOT the exported files. Gated by the off-by-default **`file-io`** capability — same posture as `download_get`.',
      inputSchema: {
        filter: z
          .object({
            mime: z
              .array(z.string())
              .optional()
              .describe(
                "Substring match against response Content-Type (case-insensitive). Any one match wins.",
              ),
            urlPattern: z
              .string()
              .optional()
              .describe("RegExp source matched case-insensitively against the URL."),
            minBytes: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe("Inclusive lower bound on encoded response byte size (when known)."),
            maxBytes: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe("Inclusive upper bound on encoded response byte size (when known)."),
            status: z
              .array(z.number().int())
              .optional()
              .describe("Allow-list of HTTP status codes. Default: 200..299."),
          })
          .describe("Filter applied to every entry in the session's network ring."),
        intoDir: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output directory. Default `assets/<sessionId>-<ISO>/`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        maxCount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Override the per-call file count cap (default 10000; clamped to hard ceiling 50000).",
          ),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Override the per-call total byte cap (default 500 MiB; clamped to hard ceiling 2 GiB).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("asset_export");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const result = await withDeadline(
          assetExport(requireCdp(e.session), e.session.page(), e.network, workspace.root, e.id, {
            filter: args.filter ?? {},
            intoDir: args.intoDir,
            maxCount: args.maxCount,
            maxBytes: args.maxBytes,
          }),
          cfgActionTimeout(),
          "asset_export",
        );
        const json = JSON.stringify(result);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `pdf_save` — print the current page to a workspace-rooted PDF via
  // Playwright `page.pdf()` (CDP `Page.printToPDF`). The mirror of
  // `upload_file`: file-io OUT instead of IN. Chromium-only (every browxai
  // session is Chromium so that's fine); refuses cleanly on `attached`/BYOB
  // sessions where driving PrintToPDF would surface a print dialog / mutate
  // the human's window state. Workspace-rooted by construction.
  register(
    "pdf_save",
    {
      description:
        "Print the current page to a workspace-rooted PDF via Playwright `page.pdf()` (CDP `Page.printToPDF`). The first-class alternative to screenshot-and-OCR or driving the browser's print-to-file dialog with `shortcut`. → `{ ok, path, bytes, format, scale, printBackground }`. Defaults: `format:\"A4\"`, `scale:1`, `printBackground:false` (matches browser-print's default — opt in when background colour/imagery matters). Output `path` is resolved INSIDE `$BROWX_WORKSPACE` (a path escaping the workspace is rejected); omit it for a default `pdfs/<sessionId>-<ts>.pdf`. **Refuses on `attached`/BYOB sessions** — `page.pdf()` drives Chromium's PrintToPDF and would mutate the human's window state; open a managed (`persistent`/`incognito`) session and re-run there. Capability `action`.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted file path for the PDF. Default `pdfs/<sessionId>-<ts>.pdf`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        format: z
          .enum(["Letter", "Legal", "Tabloid", "Ledger", "A0", "A1", "A2", "A3", "A4", "A5", "A6"])
          .optional()
          .describe('Paper format. Default "A4".'),
        scale: z
          .number()
          .min(0.1)
          .max(2.0)
          .optional()
          .describe(
            "Render scale. Default 1. Bounded to [0.1, 2.0] (Playwright's CDP-layer clamp).",
          ),
        printBackground: z
          .boolean()
          .optional()
          .describe(
            "Include CSS background-color / background-image. Default false (matches browser-print default).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("pdf_save");
      if (g) return g;
      const e = await entryFor(args.session);
      const eg = engineGate("pdf_save", e);
      if (eg) return eg;
      try {
        const refused = assertPdfSupported({ mode: e.mode });
        if (refused) {
          const body = { ok: false, error: refused.error, hint: refused.hint };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const r = await withDeadline(
          pdfSave(e.session.page(), workspace.root, e.id, {
            path: args.path,
            format: args.format,
            scale: args.scale,
            printBackground: args.printBackground,
          }),
          cfgActionTimeout(),
          "pdf_save",
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `page_archive` — save the current page (HTML + linked resources) as a
  // self-contained artefact, either as a directory (`index.html` + `assets/`
  // sidecar) or as a single-file inlined HTML. Workspace-rooted by
  // construction (same `resolveWorkspacePath` posture as `pdf_save` /
  // `start_har`). Under the off-by-default `file-io` capability — a deliberate
  // filesystem egress, not a routine action. The agent is expected to
  // navigate + settle the page BEFORE calling: the tool does not inject its
  // own wait. The output is faithfully UNMASKED — see archive.ts header for
  // the secrets-masking deliberate-gap rationale.
  register(
    "page_archive",
    {
      description:
        "Save the current page as a self-contained archive. Two formats: `directory` (default) writes `<path>/index.html` + `<path>/assets/` sidecar with every linked resource (images, fonts, scripts, stylesheets, CSS background-images surfaced via getComputedStyle); HTML refs rewritten to relative `assets/...` paths. `single-file` writes one HTML at `<path>` with every resource inlined as a `data:` URI (browsers struggle past ~150 MB — large pages should prefer `directory`). `path` is resolved INSIDE `$BROWX_WORKSPACE` (escape rejected); omit for `archives/<sessionId>-<ISO>` (directory) or `archives/<sessionId>-<ISO>.html` (single-file). `maxSizeMb` caps the total archive (default 200) — resources past the budget land in `droppedCount`. Resource fetching runs `await fetch(url)` IN-page (subject to the page's CSP `connect-src` — cross-origin blocks are caught, dropped, and counted). → `{ ok, format, path, sizeBytes, resourceCount, droppedCount, warnings[] }`. **Secrets-masking caveat**: the archive is intentionally UNMASKED — running the egress masking layer would corrupt inline JSON/CSS/binary bytes; treat the archive as sensitive (same posture as `dump_storage_state`). Caller must navigate + settle the page BEFORE calling; `page_archive` does not inject its own wait. Capability `file-io`.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output path (directory for `directory` format; .html file for `single-file`). Default `archives/<sessionId>-<ISO>[.html]`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        format: z
          .enum(["directory", "single-file"])
          .optional()
          .describe(
            "`directory` (default) → index.html + assets/ sidecar; `single-file` → one HTML with data:-URI-inlined resources.",
          ),
        maxSizeMb: z
          .number()
          .positive()
          .max(10_000)
          .optional()
          .describe(
            "Total archive size cap (MB). Default 200. Resources past the budget are dropped + counted.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("page_archive");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          pageArchive(e.session.page(), workspace.root, e.id, {
            path: args.path,
            format: args.format,
            maxSizeMb: args.maxSizeMb,
          }),
          cfgActionTimeout(),
          "page_archive",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `element_export` — save the subtree under one ref as a self-contained
  // HTML snippet plus its rendered CSS + linked resources. Sibling to
  // `page_archive`, scoped to a single element instead of the whole
  // document. Workspace-rooted output by construction; same UNMASKED
  // posture as `page_archive` (rationale: secrets-masking is literal-
  // substring substitution that would corrupt inline JSON / CSS /
  // binary bytes).
  register(
    "element_export",
    {
      description:
        "Save a specific element subtree as a self-contained snippet — outerHTML + page-wide stylesheets + every linked resource the subtree references. Two formats: `directory` (default) writes `<intoDir>/element.html` + `<intoDir>/assets/` sidecar with images / fonts / scripts / stylesheets / CSS background-images (rewriting internal refs to relative `assets/...` paths); `single-file` writes one self-contained HTML at `<intoDir>` with resources inlined as `data:` URIs (browsers struggle past ~150 MB — large subtrees should prefer `directory`). `ref` must come from a prior `snapshot()` / `find()`; ref-not-found is a structured error, not a silent miss. `intoDir` is resolved INSIDE `$BROWX_WORKSPACE` (escape rejected); omit for `elements/<sessionId>-<ISO>-<ref>` (directory) or `elements/<sessionId>-<ISO>-<ref>.html` (single-file). `maxSizeMb` caps the total export (default 50, smaller than `page_archive`'s 200 — a snippet is meant to be a slice). Cross-origin stylesheets the page can't read are reported in `warnings[]` (the snippet may render differently than the source page). → `{ ok, format, ref, path, sizeBytes, resourceCount, droppedCount, warnings[] }`. **Secrets-masking caveat**: the export is intentionally UNMASKED — running the egress masking layer would corrupt the file; treat the export as sensitive (same posture as `page_archive` / `dump_storage_state`). Capability `file-io`.",
      inputSchema: {
        ref: z
          .string()
          .describe(
            "Ref of the element subtree to export. Minted by a prior `snapshot()` / `find()`.",
          ),
        format: z
          .enum(["directory", "single-file"])
          .optional()
          .describe(
            "`directory` (default) → element.html + assets/ sidecar; `single-file` → one HTML with data:-URI-inlined resources + inline CSS.",
          ),
        intoDir: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output target (directory for `directory` format; .html file for `single-file`). Default `elements/<sessionId>-<ISO>-<ref>[.html]`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        maxSizeMb: z
          .number()
          .positive()
          .max(10_000)
          .optional()
          .describe(
            "Total export size cap (MB). Default 50. Resources past the budget are dropped + counted.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("element_export");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          elementExportFromRef(e.session.page(), e.refs, workspace.root, e.id, {
            ref: args.ref,
            format: args.format,
            intoDir: args.intoDir,
            maxSizeMb: args.maxSizeMb,
          }),
          cfgActionTimeout(),
          "element_export",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `dom_export` — full DOM dump, either as `document.documentElement.
  // outerHTML` (the platform serialization, but blind to shadow content)
  // or as a JSONL node-per-line tree that DOES descend open shadow roots.
  // Closed shadow roots are a web-platform constraint — unreachable from
  // any tool. Workspace-rooted output; same UNMASKED posture as
  // `page_archive` / `element_export`.
  register(
    "dom_export",
    {
      description:
        "Full DOM dump to a workspace-rooted file. Two formats: `html` (default) writes `document.documentElement.outerHTML` after the agent's prior stabilization — note the platform serializer does NOT include shadow-DOM content (open OR closed), even for elements that have one. `jsonl` writes one JSON object per line (`{tag, role?, attrs, text?, ref?, depth}`) via a depth-first walk that DOES descend open shadow roots when `includeShadow:true` (default). Closed shadow roots are inaccessible by web-platform design — the tree behind them is genuinely unreachable from this dump, surfaced in `warnings[]` when custom elements are present. `path` is resolved INSIDE `$BROWX_WORKSPACE` (escape rejected); omit for `dom-dumps/<sessionId>-<ISO>.{html|jsonl}`. → `{ ok, format, path, sizeBytes, nodeCount, shadowRootCount, warnings[] }`. **Secrets-masking caveat**: the dump is intentionally UNMASKED — running the egress masking layer would corrupt inline JSON / CSS / binary bytes; treat the dump as sensitive (same posture as `page_archive` / `dump_storage_state`). Caller must navigate + settle the page BEFORE calling. Capability `file-io`.",
      inputSchema: {
        format: z
          .enum(["html", "jsonl"])
          .optional()
          .describe(
            "`html` (default) → documentElement.outerHTML (shadow content not serialised); `jsonl` → one JSON node per line, depth-first, descends open shadow roots when `includeShadow`.",
          ),
        includeShadow: z
          .boolean()
          .optional()
          .describe(
            "Walk open shadow roots (`jsonl` mode). Default `true`. Closed shadow roots are inaccessible regardless.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output file. Default `dom-dumps/<sessionId>-<ISO>.{html|jsonl}`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("dom_export");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          domExport(e.session.page(), workspace.root, e.id, {
            format: args.format,
            includeShadow: args.includeShadow,
            path: args.path,
          }),
          cfgActionTimeout(),
          "dom_export",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `overflow_detect` — diagnose page-layout overflow on the target page.
  // The silent UI-breakage primitive: clipped buttons, ellipsis-truncated
  // labels, horizontal-scrollbar-on-mobile bugs. Generalises `inspect`'s
  // per-element overflow check into a page-wide scan with four typed
  // detectors (`layout`, `clipped`, `text-ellipsis`, `viewport-horizontal`).
  // Read-only, no mutation, no new capability — rides `read`.
  register(
    "overflow_detect",
    {
      description:
        'Diagnose page-layout overflow — the silent UI-breakage primitive (clipped buttons, ellipsis-truncated labels, horizontal-scrollbar-on-mobile bugs). Walks the DOM and reports one finding per offending element across four detector types: `layout` (`scrollWidth/Height > clientWidth/Height` on an element with `overflow:auto|scroll` — scrollbar present but content overruns), `clipped` (same dimensions but `overflow:hidden|clip` — content invisible with no scrollbar to recover, the highest-value finding), `text-ellipsis` (`text-overflow:ellipsis` with `scrollWidth > clientWidth` — surfaces `visibleText` heuristic + `fullText` truth), `viewport-horizontal` (singleton: `documentElement.scrollWidth > clientWidth` — the body horizontal-scrollbar mobile bug; evidence carries the overrun amount + the widest overrunning descendant when cheaply identifiable). EPSILON = 1 CSS px tolerates sub-pixel rounding noise. `scope:"document"` (default) walks every element; `scope:"viewport"` skips elements fully off-screen. `types:[...]` filters which detectors fire (default = all four; empty array also treated as default). `limit` caps findings (default 50, max 500; over-cap sets `truncated:true`). Walk bounded at 10000 elements — a hit surfaces a `warnings[]` entry suggesting `scope:viewport` for a narrower pass. Each finding: `{selector, bbox: {x,y,w,h} | null, type, evidence}`. Selector synthesis tiers: `[data-testid]` > `[role][aria-label]` > nth-of-type CSS path (≤5 levels) > `tag.classes` (≤3); capped at 200 chars (longer falls through to bare tag with `evidence.selectorTruncated`). Read-only (capability `read`).',
      inputSchema: {
        scope: z
          .enum(["viewport", "document"])
          .optional()
          .describe(
            "`document` (default) walks every element; `viewport` skips elements fully off-screen — cheaper on very large pages.",
          ),
        types: z
          .array(z.enum(["layout", "clipped", "text-ellipsis", "viewport-horizontal"]))
          .optional()
          .describe(
            "Detector types to surface. Default = all four. Empty array treated as default (an empty filter would silently match nothing — usage error).",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe(
            "Cap on findings returned. Default 50, max 500. Findings past the cap are dropped + `truncated:true` is set.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("overflow_detect");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          detectOverflow(e.session.page(), {
            scope: args.scope,
            types: args.types,
            limit: args.limit,
          }),
          cfgActionTimeout(),
          "overflow_detect",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
