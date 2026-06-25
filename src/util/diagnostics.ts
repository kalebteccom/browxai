// Diagnostics — structured per-call recording + agent self-feedback.
//
// . Off-by-default `diagnostics` capability; once enabled, every MCP
// tool call is recorded as a JSONL line in
//   $BROWX_WORKSPACE/diagnostics/<sessionId>/<server-start-ISO>.jsonl
// and the three diagnostics_* tools surface a read-side query / report.
//
// . This module owns the recorder lifecycle + file IO + retention. The pure
// redaction / eval-taxonomy / result-classification helpers live in the
// leaf `./diagnostics-redact.js`; the read-side report aggregation lives in
// `./diagnostics-report.js`. Both are re-exported below so the public surface
// stays importable from "./diagnostics.js" unchanged. This file may import
// from those two; they must NOT import back (no cycle).
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
import { resolveWorkspacePath } from "./workspace.js";
import type { SecretRegistry } from "./secrets.js";
import type { DiagnosticsRecord } from "./diagnostics-redact.js";

// ---------------------------------------------------------------------------
// Barrel re-exports — pure redaction / taxonomy helpers + shared record types
// (owned by ./diagnostics-redact.js) and the read-side report aggregation
// (owned by ./diagnostics-report.js). Re-exported here so the public surface
// stays importable from "./diagnostics.js" unchanged.
// ---------------------------------------------------------------------------

export type {
  NoteCategory,
  NoteSeverity,
  EvalTaxonomy,
  RedactedArgs,
  CallRecord,
  NoteRecord,
  DiagnosticsRecord,
} from "./diagnostics-redact.js";
export {
  redactArgs,
  classifyEvalExpr,
  failureKindOf,
  buildResultMeta,
  buildEvalJsCapture,
} from "./diagnostics-redact.js";
export type { ReportSummary } from "./diagnostics-report.js";
export { buildReportSummary } from "./diagnostics-report.js";

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** Default retention window in days. Mirrors the standing rule that
 *  diagnostics is a development-time aid, not a long-term log archive. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Workspace subdir for diagnostics JSONL. */
const DIAG_DIR = "diagnostics";

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
export function sweepRetention(
  workspaceRoot: string,
  retentionDays: number,
  now: number = Date.now(),
): {
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
    try {
      st = statSync(sessionDir);
    } catch {
      continue;
    }
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
    } catch {
      /* best-effort */
    }
    if (newest === 0 || newest < cutoff) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
        removed.push(id);
      } catch {
        /* best-effort */
      }
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
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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
    try {
      sessionDirs = readdirSync(root).sort();
    } catch {
      return out;
    }
    for (const id of sessionDirs) {
      const sd = join(root, id);
      let st;
      try {
        st = statSync(sd);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let files: string[] = [];
      try {
        files = readdirSync(sd);
      } catch {
        continue;
      }
      // Order files by mtime, oldest first.
      const withMtime: Array<{ file: string; mtime: number }> = [];
      for (const f of files) {
        try {
          withMtime.push({ file: f, mtime: statSync(join(sd, f)).mtimeMs });
        } catch {
          /* skip */
        }
      }
      withMtime.sort((a, b) => a.mtime - b.mtime);
      for (const { file } of withMtime) {
        const full = join(sd, file);
        let raw = "";
        try {
          raw = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line) as DiagnosticsRecord;
            out.push(obj);
          } catch {
            /* skip malformed */
          }
        }
      }
    }
    return out;
  }

  /** Snapshot the cumulative capability-denials counter. */
  denialsCount(): number {
    return this.denials;
  }
}

// ---------------------------------------------------------------------------
// Mask helper re-exported for the dispatch wrapper
// ---------------------------------------------------------------------------

export { maskedArgs };
