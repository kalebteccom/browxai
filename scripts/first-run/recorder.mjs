// Collects what a section records: one entry per command (exit code, wall time, output), the differences from the docs
// (DIFF, they make the run exit 1) and the observations that are not differences (NOTE).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secs } from "./block.mjs";

export function recorder(logDir) {
  if (logDir) mkdirSync(logDir, { recursive: true });
  const entries = [];
  const diffs = [];
  const notes = [];
  return {
    entries,
    diffs,
    notes,
    /** Record a finished command (from proc.mjs `run`). The full output goes to a log file under logDir. */
    add(label, r, extra = "") {
      const n = entries.length + 1;
      entries.push({
        head: `[${n}] ${label} | exit ${r.code} | ${secs(r.ms)}${r.timedOut ? " | TIMED OUT" : ""}${extra}`,
        output: r.output,
      });
      if (logDir) {
        const slug = label.replace(/[^a-z0-9]+/gi, "-").slice(0, 50);
        writeFileSync(join(logDir, `${String(n).padStart(2, "0")}-${slug}.log`), r.output);
      }
      return r;
    },
    /** A line in the printed block that is not a command. */
    line(text, output = "") {
      entries.push({ head: text, output });
    },
    diff(text) {
      diffs.push(`DIFF: ${text}`);
    },
    note(text) {
      notes.push(`NOTE: ${text}`);
    },
    /** The closing lines of a block. */
    tail(code) {
      return [
        ...diffs,
        ...notes,
        `result: ${diffs.length} difference(s), ${notes.length} note(s), exit ${code}`,
      ];
    },
  };
}
