import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface DiagnosticsCallRecord {
  readonly kind: "call";
  readonly ts: string;
  readonly tool: string;
  readonly sessionId: string;
  readonly argsRedacted?: unknown;
  readonly resultMeta?: {
    readonly ok?: boolean;
    readonly sizeBytes?: number;
    readonly warningsCount?: number;
    readonly failureKind?: string;
  };
  readonly durationMs?: number;
}

function isDiagnosticsCall(value: unknown, sessionId: string): value is DiagnosticsCallRecord {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return obj.kind === "call" && obj.sessionId === sessionId && typeof obj.tool === "string";
}

export async function readDiagnosticsRecords(
  workspace: string,
  sessionId: string,
): Promise<DiagnosticsCallRecord[]> {
  const dir = join(workspace, "diagnostics", sessionId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const withMtime: Array<{ file: string; mtime: number }> = [];
  for (const file of files) {
    const full = join(dir, file);
    try {
      const st = await stat(full);
      if (st.isFile() && file.endsWith(".jsonl")) withMtime.push({ file, mtime: st.mtimeMs });
    } catch {
      /* skip unreadable files */
    }
  }
  withMtime.sort((a, b) => a.mtime - b.mtime);

  const records: DiagnosticsCallRecord[] = [];
  for (const { file } of withMtime) {
    const raw = await readFile(join(dir, file), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isDiagnosticsCall(parsed, sessionId)) records.push(parsed);
      } catch {
        /* tolerate partial JSONL writes */
      }
    }
  }
  return records;
}
