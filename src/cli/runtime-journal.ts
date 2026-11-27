// `browxai runtime`: the journal, one JSON line per check, apply, rollback, gc,
// Upgrading note and updater fallback in `<runtime>/journal.jsonl`, mode 0600.
// It records versions, integrity hashes,
// reasons and timings, never a token or an npm config value. At 1 MB the file
// moves to `journal.jsonl.1`, replacing the one before, so the journal holds
// between 1 and 2 MB.

import { appendFileSync, chmodSync, readFileSync, renameSync, statSync } from "node:fs";
import type { RuntimePaths } from "./runtime-layout.js";

export const JOURNAL_MAX_BYTES = 1024 * 1024;

export type JournalEvent =
  | "check"
  | "apply"
  | "rollback"
  | "gc"
  | "offline"
  | "error"
  | "skip"
  | "notes"
  /** Written by the launcher: the background run used the previous version's updater. */
  | "fallback";

export interface JournalEntry {
  at: string;
  event: JournalEvent;
  /** `auto` for the background job, `manual` for a command someone ran. */
  mode?: "auto" | "manual";
  version?: string;
  from?: string;
  result?: string;
  reason?: string;
  integrity?: string;
  ms?: number;
  /** The Upgrading notes of `version`, for a `notes` entry. */
  notes?: string;
}

/** Append one entry. A journal that can't be written never stops an update. */
export function appendJournal(
  paths: RuntimePaths,
  entry: JournalEntry,
  maxBytes = JOURNAL_MAX_BYTES,
): void {
  const line = JSON.stringify(entry) + "\n";
  try {
    rotate(paths, Buffer.byteLength(line), maxBytes);
    appendFileSync(paths.journal, line, { mode: 0o600 });
    chmodSync(paths.journal, 0o600);
  } catch {
    /* the journal is a record, not a gate */
  }
}

function rotate(paths: RuntimePaths, adding: number, maxBytes: number): void {
  let size: number;
  try {
    size = statSync(paths.journal).size;
  } catch {
    return;
  }
  if (size + adding > maxBytes) renameSync(paths.journal, `${paths.journal}.1`);
}

/** The entries of the current journal file, oldest first. Lines that don't parse are skipped. */
export function readJournal(paths: RuntimePaths): JournalEntry[] {
  let text: string;
  try {
    text = readFileSync(paths.journal, "utf8");
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as JournalEntry);
    } catch {
      /* a torn line from a killed run */
    }
  }
  return out;
}
