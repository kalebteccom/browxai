// Append-only JSONL action log for the spike. Every tool call gets one line.
// Post-hoc analysis derives retry / wrong-action counts from this.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LogEntry {
  ts: string;          // ISO timestamp
  surface: "raw" | "curated";
  task: string;        // run id (env BROWX_SPIKE_TASK, or "adhoc")
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
  result_summary?: string;   // short text (e.g. "navigated to X", "3 candidates")
  error?: string;
}

export class Logger {
  constructor(private path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  write(entry: LogEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}
