// Diagnostics — structured per-call recording + agent self-feedback.
//
// Phase 7.5. Off-by-default `diagnostics` capability; once enabled, every MCP
// tool call is recorded as a JSONL line in
//   $BROWX_WORKSPACE/diagnostics/<sessionId>/<server-start-ISO>.jsonl
// and the three diagnostics_* tools surface a read-side query / report.
//
// Recorder posture (LOAD-BEARING):
//   1. ZERO observable side-effect when the capability is OFF — no allocations
//      beyond a single boolean gate check, no file IO, no recorder method
//      calls. The dispatch wrapper in server.ts short-circuits on
//      `recorder.enabled` before doing anything else.
//   2. Runs DOWNSTREAM of the URL sanitiser + secrets-masking egress
//      chokepoint — by the time the recorder sees a tool result, every
//      egress sink has already rewritten registered secret values back to
//      `<NAME>` aliases. The recorder additionally walks args through the
//      same `applyMaskDeep` helper so a secret echoed in the call ARGS (e.g.
//      a `fill({value:<PASSWORD>})` that materialised at dispatch) never
//      lands raw in the JSONL.
//   3. Workspace-rooted by construction via `resolveWorkspacePath` — a
//      session id of `../escape` is rejected at the path-resolution chokepoint
//      and the dispatch path falls back to a no-op (the call still runs;
//      only the recording is skipped).
//
// Storage shape (JSONL — one record per line, append-only):
//   { kind:"call", ts, tool, sessionId, argsRedacted, resultMeta:{ok,
//     sizeBytes, warningsCount, failureKind}, durationMs, capabilityDenials,
//     agentId?, evalJs?:{exprSha, exprHead, returnType, returnSizeBytes,
//     taxonomy} }
//   { kind:"note", ts, sessionId, insight, category, severity, ref?, agentId? }
//
// Retention: env `BROWX_DIAGNOSTICS_RETENTION_DAYS` (default 30). Expired
// session directories are removed at server start AND on session close.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { join, sep as pathSep } from "node:path";
import { resolveWorkspacePath } from "../session/storage.js";
import type { SecretRegistry } from "./secrets.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Categories a `diagnostics_note` insight can carry. Default `other`. */
export type NoteCategory =
  | "missing-primitive"
  | "workaround"
  | "perf-concern"
  | "ergonomic-friction"
  | "other";

/** Severity a `diagnostics_note` can carry. Default `info`. */
export type NoteSeverity = "info" | "warn" | "blocker";

/** Eval-expression taxonomy buckets — heuristic substring-match classifier. */
export type EvalTaxonomy =
  | "dom-query"
  | "storage-access"
  | "computed-style"
  | "callback-trigger"
  | "feature-detect"
  | "custom";

/** Structural redaction of a tool call's args. Keeps key names + types +
 *  sizes; drops raw values for known large / sensitive payload fields. */
export type RedactedArgs = Record<string, unknown>;

export interface CallRecord {
  kind: "call";
  ts: string;
  tool: string;
  sessionId: string;
  argsRedacted: RedactedArgs;
  resultMeta: {
    ok: boolean;
    sizeBytes: number;
    warningsCount: number;
    failureKind?: string;
  };
  durationMs: number;
  capabilityDenials: number;
  agentId?: string;
  evalJs?: {
    exprSha: string;
    exprHead: string;
    returnType: string;
    returnSizeBytes: number;
    taxonomy: EvalTaxonomy;
  };
}

export interface NoteRecord {
  kind: "note";
  ts: string;
  sessionId: string;
  insight: string;
  category: NoteCategory;
  severity: NoteSeverity;
  ref?: string;
  agentId?: string;
}

export type DiagnosticsRecord = CallRecord | NoteRecord;

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** Default retention window in days. Mirrors the standing rule that
 *  diagnostics is a development-time aid, not a long-term log archive. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Workspace subdir for diagnostics JSONL. */
const DIAG_DIR = "diagnostics";

/** Field names whose payload is opportunistically rewritten to sha256 +
 *  byteLength when the string is large (above the inline threshold). Small
 *  strings — a `fill({value:"hi"})` or a typed `<NAME>` alias — pass through
 *  the standard string-truncation path so the JSONL stays human-debuggable
 *  for the common short-value case. The threshold mirrors the structural
 *  intent: redact for content blobs (caches_put body, idb_put value,
 *  eval_js expr fragments), not for typed UI strings. */
const BIG_BLOB_FIELDS = new Set([
  "body",
  "contentBase64",
  "value",
  "expr",
  "expression",
  "data",
  "contents",
  "html",
  "source",
]);
/** Threshold (bytes) above which a `BIG_BLOB_FIELDS` field is rewritten to
 *  sha256 + byteLength. Below this, the standard truncation path applies. */
const BIG_BLOB_REDACT_BYTES = 512;

/** Args fields the recorder rewrites to the `<NAME>` alias before writing,
 *  using the same `applyMaskDeep` the egress sinks do — so a secret echoed in
 *  args never reaches the JSONL raw. (The masking layer at egress catches it
 *  on result side; this catches it on args side.) */
function maskedArgs(args: unknown, secrets: SecretRegistry | null): unknown {
  if (!secrets) return args;
  return secrets.applyMaskDeep(args);
}

/** Resolve the diagnostics root path under the workspace. Rejects any
 *  session id that escapes the diagnostics subdir (`../escape`,
 *  absolute paths). The thrown error carries a stable prefix the dispatch
 *  wrapper recognises to fall back to no-op. */
export function resolveDiagnosticsPath(
  workspaceRoot: string,
  sessionId: string,
  serverStartIso: string,
): string {
  // `resolveWorkspacePath` rejects anything escaping the workspace root;
  // we want stricter — the path must escape NEITHER the workspace nor the
  // diagnostics subdir. Compose by resolving the full relative path and
  // checking the prefix.
  const rel = join(DIAG_DIR, sessionId, `${serverStartIso}.jsonl`);
  const resolved = resolveWorkspacePath(workspaceRoot, rel, "diagnostics");
  const diagRoot = resolveWorkspacePath(workspaceRoot, DIAG_DIR, "diagnostics");
  if (resolved !== diagRoot && !resolved.startsWith(diagRoot + pathSep)) {
    throw new Error(
      `diagnostics: sessionId "${sessionId}" must not escape the diagnostics ` +
      `subdir — got resolved path "${resolved}"`,
    );
  }
  return resolved;
}

/** Returns the diagnostics root dir (creating it if needed). The path is
 *  workspace.root-rooted by construction — caller passes `workspace.root`
 *  from `resolveWorkspace()`. */
export function ensureDiagnosticsRoot(workspaceRoot: string): string {
  // workspace.root-rooted by construction (see comment above).
  const root = join(workspaceRoot, DIAG_DIR);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

/** Resolve retention window from env. Defaults to 30 days; negative /
 *  non-numeric falls back to the default with no error. `0` disables the
 *  sweep (everything is kept). */
export function resolveRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BROWX_DIAGNOSTICS_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(parsed);
}

/** Remove session directories whose newest JSONL file is older than the
 *  retention window. `0` disables the sweep entirely. Best-effort: a
 *  permission error on one session doesn't block the rest. */
export function sweepRetention(workspaceRoot: string, retentionDays: number, now: number = Date.now()): {
  removed: string[];
  kept: string[];
} {
  const root = join(workspaceRoot, DIAG_DIR);
  if (!existsSync(root) || retentionDays <= 0) return { removed: [], kept: [] };
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  const kept: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return { removed, kept };
  }
  for (const id of entries) {
    const sessionDir = join(root, id);
    let st;
    try { st = statSync(sessionDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    // Newest mtime across the session's JSONL files. If none, treat as
    // ancient — the directory predates any retained run.
    let newest = 0;
    try {
      for (const file of readdirSync(sessionDir)) {
        const full = join(sessionDir, file);
        const fst = statSync(full);
        if (fst.mtimeMs > newest) newest = fst.mtimeMs;
      }
    } catch { /* best-effort */ }
    if (newest === 0 || newest < cutoff) {
      try { rmSync(sessionDir, { recursive: true, force: true }); removed.push(id); }
      catch { /* best-effort */ }
    } else {
      kept.push(id);
    }
  }
  return { removed, kept };
}

/** Remove a single session's diagnostics directory. Used on session close. */
export function removeSessionDiagnostics(workspaceRoot: string, sessionId: string): boolean {
  const root = join(workspaceRoot, DIAG_DIR);
  // Reject escape attempts the same way the write path does.
  let dir: string;
  try {
    dir = resolveWorkspacePath(workspaceRoot, join(DIAG_DIR, sessionId), "diagnostics");
  } catch {
    return false;
  }
  const diagRoot = root;
  if (dir !== diagRoot && !dir.startsWith(diagRoot + pathSep)) return false;
  if (!existsSync(dir)) return false;
  try { rmSync(dir, { recursive: true, force: true }); return true; }
  catch { return false; }
}

/**
 * The recorder. One instance per server. The capability gate is captured at
 * construction; `enabled` is the public hot-path flag the dispatch wrapper
 * checks BEFORE allocating anything (zero-overhead off-path).
 */
export class DiagnosticsRecorder {
  /** Hot-path gate — checked at the dispatch boundary. When false, every
   *  recorder method short-circuits to a no-op AND the dispatch wrapper
   *  is expected to NOT enter the recorder code path at all. */
  readonly enabled: boolean;
  readonly serverStartIso: string;
  readonly workspaceRoot: string;
  readonly retentionDays: number;
  /** Capability denials accumulator (process-wide). Mirrors the snapshot the
   *  session-metrics module tracks per-session; diagnostics tracks it across
   *  every session to surface a single "how many gate hits did this server
   *  see" rollup in `diagnostics_report`. */
  private denials = 0;

  constructor(opts: {
    enabled: boolean;
    workspaceRoot: string;
    serverStartIso?: string;
    retentionDays?: number;
  }) {
    this.enabled = opts.enabled;
    this.workspaceRoot = opts.workspaceRoot;
    this.serverStartIso = opts.serverStartIso ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  /** Write one record. No-op when the recorder is disabled or the path
   *  resolution fails (workspace escape — the call still runs, only the
   *  recording is skipped). */
  write(record: DiagnosticsRecord): void {
    if (!this.enabled) return;
    let path: string;
    try {
      path = resolveDiagnosticsPath(this.workspaceRoot, record.sessionId, this.serverStartIso);
    } catch {
      // Workspace-escape: skip silently. The session id was already
      // validated upstream (session ids are agent-provided strings); a
      // pathological id here means the agent passed `../escape` to a tool
      // that didn't validate — the call still runs, just unrecorded.
      return;
    }
    // `dir` is workspace.root-rooted by construction — `resolveDiagnosticsPath`
    // (above) rejects any path that escapes `workspace.root`, so a successful
    // resolve guarantees `<workspace>/diagnostics/<sessionId>/` lives under
    // BROWX_WORKSPACE.
    const dir = join(this.workspaceRoot, DIAG_DIR, record.sessionId);
    try {
      // ws.sub-equivalent: parent dir creation rooted at workspace.root.
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // workspace.root-rooted by construction (see comment above).
      appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
    } catch {
      // Best-effort — a disk-full / permission error on the diagnostics
      // path must NEVER take down a tool call.
    }
  }

  /** Increment the capability-denials counter — surfaced on
   *  `diagnostics_report` so the agent's "tried to use a gated tool"
   *  pattern is one read. */
  noteDenial(): void {
    if (!this.enabled) return;
    this.denials += 1;
  }

  /** Read-back: enumerate every record in the workspace's diagnostics
   *  store. Order: by session id, then by file mtime (oldest first), then
   *  by line order within a file. Used by the read-side query tools.
   *  Best-effort — unreadable files are skipped. */
  readAll(): DiagnosticsRecord[] {
    const out: DiagnosticsRecord[] = [];
    const root = join(this.workspaceRoot, DIAG_DIR);
    if (!existsSync(root)) return out;
    let sessionDirs: string[] = [];
    try { sessionDirs = readdirSync(root).sort(); } catch { return out; }
    for (const id of sessionDirs) {
      const sd = join(root, id);
      let st;
      try { st = statSync(sd); } catch { continue; }
      if (!st.isDirectory()) continue;
      let files: string[] = [];
      try { files = readdirSync(sd); } catch { continue; }
      // Order files by mtime, oldest first.
      const withMtime: Array<{ file: string; mtime: number }> = [];
      for (const f of files) {
        try { withMtime.push({ file: f, mtime: statSync(join(sd, f)).mtimeMs }); }
        catch { /* skip */ }
      }
      withMtime.sort((a, b) => a.mtime - b.mtime);
      for (const { file } of withMtime) {
        const full = join(sd, file);
        let raw = "";
        try { raw = readFileSync(full, "utf8"); } catch { continue; }
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line) as DiagnosticsRecord;
            out.push(obj);
          } catch { /* skip malformed */ }
        }
      }
    }
    return out;
  }

  /** Snapshot the cumulative capability-denials counter. */
  denialsCount(): number { return this.denials; }
}

// ---------------------------------------------------------------------------
// Args-redaction
// ---------------------------------------------------------------------------

/** Structural redaction — keep keys + types + sizes, drop raw values for
 *  known large / sensitive fields. Bounded depth. The output is small,
 *  diff-friendly, and never includes a registered secret value (the
 *  recorder applies the secrets mask on top of this before writing). */
export function redactArgs(args: unknown, depth = 0): RedactedArgs {
  if (depth > 6) return { __truncated: true };
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    return { __scalar: typeof args, __value: args };
  }
  const out: RedactedArgs = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (BIG_BLOB_FIELDS.has(k) && typeof v === "string") {
      const byteLen = Buffer.byteLength(v, "utf8");
      // Only redact when the payload is genuinely large — small strings
      // (typed `<NAME>` aliases, single-line CSS values, short URLs) stay
      // readable so the JSONL keeps its diff-friendly debuggability.
      if (byteLen >= BIG_BLOB_REDACT_BYTES) {
        out[k] = {
          __redacted: true,
          sha256: createHash("sha256").update(v, "utf8").digest("hex"),
          byteLength: byteLen,
        };
        continue;
      }
    }
    if (typeof v === "string") {
      out[k] = v.length > 256 ? `${v.slice(0, 256)}…[+${v.length - 256}]` : v;
      continue;
    }
    if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v;
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = { __array: true, length: v.length };
      continue;
    }
    if (typeof v === "object") {
      out[k] = redactArgs(v, depth + 1);
      continue;
    }
    out[k] = { __type: typeof v };
  }
  return out;
}

// ---------------------------------------------------------------------------
// eval_js taxonomy classifier
// ---------------------------------------------------------------------------

/** Heuristic substring classifier over the first 80 chars of an `eval_js`
 *  expression. Drives the "what curated primitive is missing?" inference
 *  downstream (high-count non-custom buckets → propose a primitive). */
export function classifyEvalExpr(exprHead: string): EvalTaxonomy {
  const s = exprHead;
  // dom-query — querySelector / getElementBy* / closest / matches
  if (/document\.querySelector|querySelectorAll|getElementBy|\.closest\(|\.matches\(/.test(s)) {
    return "dom-query";
  }
  // storage-access — localStorage / sessionStorage / indexedDB / caches / cookies
  if (/localStorage|sessionStorage|indexedDB|\bcaches\b|document\.cookie|\bcookies\b/.test(s)) {
    return "storage-access";
  }
  // computed-style + layout-box measures
  if (/getComputedStyle|getBoundingClientRect|offsetWidth|offsetHeight|clientWidth|clientHeight|scrollWidth|scrollHeight/.test(s)) {
    return "computed-style";
  }
  // callback-trigger — .click() / .focus() / .blur() / .dispatchEvent( / .submit()
  if (/\.click\(\)|\.focus\(\)|\.blur\(\)|\.dispatchEvent\(|\.submit\(\)/.test(s)) {
    return "callback-trigger";
  }
  // feature-detect — typeof window./navigator. / 'X' in window/navigator
  if (/typeof\s+window\.|typeof\s+navigator\.|['"][^'"]+['"]\s+in\s+(window|navigator)|window\.[A-Za-z_]+\s*!==\s*undefined/.test(s)) {
    return "feature-detect";
  }
  return "custom";
}

// ---------------------------------------------------------------------------
// Result classification — drives the resultMeta + failureKind fields.
// ---------------------------------------------------------------------------

export function failureKindOf(parsed: { ok: false; [k: string]: unknown }): string {
  if (Object.prototype.hasOwnProperty.call(parsed, "requiredCapability")) return "capability-denied";
  const err = typeof parsed.error === "string" ? parsed.error : "";
  if (/anti-wedge timeout/i.test(err)) return "timeout";
  if (/not found|no element matches|ref not found|locator did not resolve/i.test(err)) return "target-not-found";
  if (/must |invalid |unknown |expected /i.test(err)) return "bad-arg";
  return "internal";
}

/** Build the `resultMeta` field for a recorded tool call. `firstJsonObj` is
 *  the parsed first text item (when applicable); `sizeBytes` is the
 *  JSON-string length of the entire content envelope; `warningsCount` is
 *  pulled from the parsed object's `warnings` field when it's an array. */
export function buildResultMeta(
  firstJsonObj: Record<string, unknown> | null,
  sizeBytes: number,
): CallRecord["resultMeta"] {
  if (!firstJsonObj) return { ok: true, sizeBytes, warningsCount: 0 };
  const ok = firstJsonObj.ok !== false;
  const warningsCount = Array.isArray(firstJsonObj.warnings) ? firstJsonObj.warnings.length : 0;
  if (ok) return { ok: true, sizeBytes, warningsCount };
  return {
    ok: false,
    sizeBytes,
    warningsCount,
    failureKind: failureKindOf(firstJsonObj as { ok: false }),
  };
}

// ---------------------------------------------------------------------------
// eval_js deep-capture helpers
// ---------------------------------------------------------------------------

const EVAL_HEAD_LEN = 80;

/** Build the eval_js-specific deep-capture envelope from a tool call's
 *  args + result. Returns undefined when the tool isn't eval_js. */
export function buildEvalJsCapture(
  toolName: string,
  args: unknown,
  firstJsonObj: Record<string, unknown> | null,
): CallRecord["evalJs"] | undefined {
  if (toolName !== "eval_js" && toolName !== "poll_eval") return undefined;
  const expr = (args && typeof args === "object")
    ? (args as Record<string, unknown>).expr ?? (args as Record<string, unknown>).expression
    : undefined;
  if (typeof expr !== "string") return undefined;
  const exprHead = expr.slice(0, EVAL_HEAD_LEN);
  const exprSha = createHash("sha256").update(expr, "utf8").digest("hex");
  const taxonomy = classifyEvalExpr(exprHead);
  let returnType = "unknown";
  let returnSizeBytes = 0;
  if (firstJsonObj) {
    const v = firstJsonObj.value;
    returnType = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    try { returnSizeBytes = Buffer.byteLength(JSON.stringify(v ?? null), "utf8"); }
    catch { returnSizeBytes = 0; }
  }
  return { exprSha, exprHead, returnType, returnSizeBytes, taxonomy };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Compute the percentile (p50, p95) over an unsorted number array. */
function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

export interface ReportSummary {
  perTool: Record<string, { count: number; failureCount: number; p50Duration: number; p95Duration: number }>;
  topEvalJsPatterns: Array<{ exprSha: string; exprHead: string; count: number; taxonomy: EvalTaxonomy }>;
  capabilityDenials: Record<string, number>;
  notesByCategory: Record<string, number>;
  missingPrimitiveHypotheses: Array<{ taxonomy: EvalTaxonomy; sampleHead: string; count: number }>;
}

export function buildReportSummary(records: DiagnosticsRecord[], opts: { since?: string; session?: string } = {}): ReportSummary {
  const sinceMs = opts.since ? Date.parse(opts.since) : undefined;
  const perTool = new Map<string, { count: number; failureCount: number; durations: number[] }>();
  const evalByPattern = new Map<string, { count: number; exprHead: string; taxonomy: EvalTaxonomy }>();
  const capabilityDenials: Record<string, number> = {};
  const notesByCategory: Record<string, number> = {};
  const evalTaxonomyCounts = new Map<EvalTaxonomy, { count: number; sampleHead: string }>();

  for (const r of records) {
    if (sinceMs !== undefined && Date.parse(r.ts) < sinceMs) continue;
    if (opts.session && r.sessionId !== opts.session) continue;
    if (r.kind === "note") {
      notesByCategory[r.category] = (notesByCategory[r.category] ?? 0) + 1;
      continue;
    }
    // call record
    const row = perTool.get(r.tool) ?? { count: 0, failureCount: 0, durations: [] };
    row.count += 1;
    if (!r.resultMeta.ok) row.failureCount += 1;
    row.durations.push(r.durationMs);
    perTool.set(r.tool, row);
    if (r.resultMeta.failureKind === "capability-denied") {
      // Pull the capability name from the tool's static map if available.
      // We don't import the map here (avoid a cycle); the report tool injects
      // a hint via the dispatcher. For now bucket by tool name — the report
      // tool overlay rewrites this to capability where possible.
      capabilityDenials[r.tool] = (capabilityDenials[r.tool] ?? 0) + 1;
    }
    if (r.evalJs) {
      const e = evalByPattern.get(r.evalJs.exprSha) ?? { count: 0, exprHead: r.evalJs.exprHead, taxonomy: r.evalJs.taxonomy };
      e.count += 1;
      evalByPattern.set(r.evalJs.exprSha, e);
      const t = evalTaxonomyCounts.get(r.evalJs.taxonomy) ?? { count: 0, sampleHead: r.evalJs.exprHead };
      t.count += 1;
      evalTaxonomyCounts.set(r.evalJs.taxonomy, t);
    }
  }

  const perToolOut: ReportSummary["perTool"] = {};
  for (const [tool, row] of perTool) {
    perToolOut[tool] = {
      count: row.count,
      failureCount: row.failureCount,
      p50Duration: percentile(row.durations, 50),
      p95Duration: percentile(row.durations, 95),
    };
  }

  const topEvalJsPatterns: ReportSummary["topEvalJsPatterns"] = [];
  for (const [exprSha, info] of evalByPattern) {
    topEvalJsPatterns.push({ exprSha, exprHead: info.exprHead, count: info.count, taxonomy: info.taxonomy });
  }
  topEvalJsPatterns.sort((a, b) => b.count - a.count);
  topEvalJsPatterns.splice(10); // top 10

  const missingPrimitiveHypotheses: ReportSummary["missingPrimitiveHypotheses"] = [];
  for (const [taxonomy, info] of evalTaxonomyCounts) {
    // Heuristic: non-custom with count >= 3 OR custom with count >= 5.
    const threshold = taxonomy === "custom" ? 5 : 3;
    if (info.count >= threshold) {
      missingPrimitiveHypotheses.push({ taxonomy, sampleHead: info.sampleHead, count: info.count });
    }
  }
  missingPrimitiveHypotheses.sort((a, b) => b.count - a.count);

  return {
    perTool: perToolOut,
    topEvalJsPatterns,
    capabilityDenials,
    notesByCategory,
    missingPrimitiveHypotheses,
  };
}

// ---------------------------------------------------------------------------
// Mask helper re-exported for the dispatch wrapper
// ---------------------------------------------------------------------------

export { maskedArgs };
