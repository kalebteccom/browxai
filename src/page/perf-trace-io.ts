// Performance trace I/O — the on-disk side of perf tracing.
//
// CDP `Tracing.end` hands back a flat array of chromium trace events; the
// chromium ecosystem (DevTools Performance, Lighthouse) reads/writes that as a
// `{ traceEvents: [...] }` JSON file. This module owns that serialization
// contract plus the workspace-rooted path guard — engine-blind by design, so
// the lifecycle state machine in `perf.ts` and the insights extractor in
// `perf-insights.ts` both share one definition of "what a trace file is" and
// "where it's allowed to live". Keeping it here (not in perf.ts) means the path
// guard / file shape can change without touching the CDP lifecycle, and the
// insights extractor can consume `TraceEvent` without dragging in tracing state.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

/** Default trace categories — covers the cases DevTools' Performance panel
 *  uses for its core insights (frames, paint, layout, long tasks, user
 *  timing, loading). Smaller than the everything-on default to keep traces
 *  manageable. */
export const DEFAULT_TRACE_CATEGORIES = [
  "devtools.timeline",
  "loading",
  "blink.user_timing",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "latencyInfo",
];

/** Trace event row, as emitted by chromium tracing. We only care about a few
 *  fields; everything else passes through. */
export interface TraceEvent {
  name?: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  args?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Workspace path helper. Mirrors `resolveWorkspacePath` in session/storage.ts
// but kept local so this module doesn't reach across page → session.

export function resolvePerfTracePath(workspaceRoot: string, p: string, tool: string): string {
  const resolved = resolve(workspaceRoot, p);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(`${tool}: \`path\` must resolve inside $BROWX_WORKSPACE — got "${p}".`);
  }
  return resolved;
}

/** Default trace filename under `<workspace>/perf-traces/<sessionId>-<ts>.json`. */
export function defaultTracePath(workspaceRoot: string, sessionId: string): string {
  // sanitize the session id for the filename — only safe chars survive.
  const safe = (sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(workspaceRoot, "perf-traces", `${safe}-${ts}.json`);
}

/** Write a trace event array as a chrome-tracing-compatible JSON file. The
 *  format the chromium ecosystem expects is `{ traceEvents: [...] }`; we
 *  also include `metadata` so a roundtrip through tracingControl tools is
 *  cleanly identifiable. */
export function writeTraceFile(
  workspaceRoot: string,
  filePath: string,
  events: TraceEvent[],
  meta: { categories: string[]; sessionId: string; durationMs: number },
  tool: string,
): { resolved: string; bytes: number } {
  // Path is workspace-rooted by construction via `resolvePerfTracePath`.
  const resolved = resolvePerfTracePath(workspaceRoot, filePath, tool);
  const parent = dirname(resolved);
  // ws.sub-style: ensure parent exists under workspace.root.
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  const payload = JSON.stringify({
    traceEvents: events,
    metadata: {
      source: "browxai",
      sessionId: meta.sessionId,
      categories: meta.categories,
      durationMs: meta.durationMs,
      eventCount: events.length,
      capturedAt: new Date().toISOString(),
    },
  });
  // ws.root-rooted path — see resolvePerfTracePath above for the guard.
  writeFileSync(resolved, payload, "utf8");
  return { resolved, bytes: Buffer.byteLength(payload, "utf8") };
}

/** Read a trace file and return the event array. */
export function readTraceFile(
  workspaceRoot: string,
  filePath: string,
  tool: string,
): { events: TraceEvent[]; metadata?: Record<string, unknown> } {
  const resolved = resolvePerfTracePath(workspaceRoot, filePath, tool);
  if (!existsSync(resolved)) {
    throw new Error(`${tool}: trace file not found at "${resolved}" — call perf_stop first`);
  }
  const raw = readFileSync(resolved, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${tool}: trace file "${resolved}" is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (Array.isArray(parsed)) {
    return { events: parsed as TraceEvent[] };
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { traceEvents?: unknown }).traceEvents)
  ) {
    const obj = parsed as { traceEvents: TraceEvent[]; metadata?: Record<string, unknown> };
    return { events: obj.traceEvents, metadata: obj.metadata };
  }
  throw new Error(
    `${tool}: trace file "${resolved}" doesn't look like a chrome trace (missing traceEvents array)`,
  );
}
