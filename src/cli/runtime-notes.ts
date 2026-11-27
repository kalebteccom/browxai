// `browxai runtime`: the Upgrading notes of each release (RFC 0015, section 6).
// The npm tarball has no CHANGELOG, so the build writes `dist/upgrading.json`
// from it (scripts/upgrading-notes.mjs). After a switch the updater copies the
// notes of every version it crossed to `<runtime>/notes/<version>.md` and to the
// journal, and lists them as unseen in state.json. `runtime notes` prints them
// and marks them seen; doctor shows a line until then. A server prints one
// standard error line on its first start of a version that has unseen notes.

import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendJournal } from "./runtime-journal.js";
import {
  cliOf,
  compareVersions,
  isVersion,
  runtimePaths,
  versionDir,
  type RuntimePaths,
} from "./runtime-layout.js";
import {
  ensurePrivateDir,
  readCurrent,
  readState,
  updateState,
  writeFileAtomic,
  type RuntimeState,
} from "./runtime-store.js";

/** The `schemaVersion` of `dist/upgrading.json` this code reads. */
export const UPGRADING_SCHEMA_VERSION = 1;

export type NotesTable = Record<string, string>;

/** The notes in one `upgrading.json`, or undefined when the file is missing or
 *  not in the shape this code reads. A version without the file predates it. */
export function readNotesTable(file: string): NotesTable | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const doc = parsed as { schemaVersion?: unknown; notes?: unknown } | null;
  if (!doc || doc.schemaVersion !== UPGRADING_SCHEMA_VERSION) return undefined;
  if (!doc.notes || typeof doc.notes !== "object" || Array.isArray(doc.notes)) return undefined;
  const out: NotesTable = {};
  for (const [v, text] of Object.entries(doc.notes as Record<string, unknown>)) {
    if (isVersion(v) && typeof text === "string" && text.trim()) out[v] = text.trim();
  }
  return out;
}

/** `dist/upgrading.json` next to a `cli.js`. */
export function upgradingFileOf(cli: string): string {
  return join(cli, "..", "upgrading.json");
}

/** The notes shipped with this process's own build. */
export function ownUpgradingFile(): string {
  return fileURLToPath(new URL("../upgrading.json", import.meta.url));
}

/** Versions in the table newer than `from` and at most `to`, oldest first. */
export function versionsBetween(table: NotesTable, from: string, to: string): string[] {
  return Object.keys(table)
    .filter((v) => compareVersions(v, from) > 0 && compareVersions(v, to) <= 0)
    .sort(compareVersions);
}

function noteFile(paths: RuntimePaths, version: string): string {
  return join(paths.notes, `${version}.md`);
}

/**
 * After a switch from `from` to `to`: write the notes of every version in
 * between to `notes/<v>.md` and the journal, and list them as unseen. Nothing
 * for a downgrade, a first install, or a version that ships no notes file. A
 * failure here never undoes the switch.
 */
export function recordNotes(
  paths: RuntimePaths,
  from: string | undefined,
  to: string,
  now: number,
  mode: "auto" | "manual",
): string[] {
  if (!from || compareVersions(to, from) <= 0) return [];
  try {
    const table = readNotesTable(upgradingFileOf(cliOf(versionDir(paths, to))));
    if (!table) return [];
    const versions = versionsBetween(table, from, to);
    if (versions.length === 0) return [];
    ensurePrivateDir(paths.notes);
    for (const v of versions) {
      writeFileAtomic(noteFile(paths, v), `Upgrading notes for ${v}\n\n${table[v]}\n`);
      appendJournal(paths, {
        at: new Date(now).toISOString(),
        mode,
        event: "notes",
        version: v,
        notes: table[v]!,
      });
    }
    updateState(paths, (s) => ({
      ...s,
      notesUnseen: [...new Set([...(s.notesUnseen ?? []), ...versions])].sort(compareVersions),
    }));
    return versions;
  } catch {
    return [];
  }
}

/** The text `runtime notes` prints for one version, or undefined when it has none. */
function noteText(paths: RuntimePaths, table: NotesTable, version: string): string | undefined {
  if (table[version]) return `Upgrading notes for ${version}\n\n${table[version]}\n`;
  try {
    return readFileSync(noteFile(paths, version), "utf8");
  } catch {
    return undefined;
  }
}

export interface NotesDeps {
  /** The browxai version this process runs. */
  version: string;
  /** This process's own `upgrading.json`, read when `current` ships none. */
  ownTable?: () => NotesTable | undefined;
  out: (text: string) => void;
}

/** The notes this runtime knows: `current`'s `upgrading.json`, else this process's. */
function knownNotes(paths: RuntimePaths, current: string | undefined, deps: NotesDeps): NotesTable {
  const fromCurrent = current
    ? readNotesTable(upgradingFileOf(cliOf(versionDir(paths, current))))
    : undefined;
  return fromCurrent ?? (deps.ownTable ?? (() => readNotesTable(ownUpgradingFile())))() ?? {};
}

/** The oldest of this process's version and `previous` that is older than `current`. */
function rangeStart(
  current: string,
  running: string,
  previous: string | undefined,
): string | undefined {
  const older = [running, previous].filter(
    (v): v is string => !!v && isVersion(v) && compareVersions(v, current) < 0,
  );
  return older.sort(compareVersions)[0];
}

/**
 * `browxai runtime notes [V]`. With V, the notes of V. Without, the unseen notes
 * and the notes of every version after the older of this process's version and
 * `previous`, up to `current`. Either way the versions printed are marked seen.
 */
export function runNotes(
  paths: RuntimePaths,
  version: string | undefined,
  deps: NotesDeps,
): number {
  const current = readCurrent(paths);
  const table = knownNotes(paths, current, deps);
  const state = readState(paths);
  let versions: string[];
  if (version) {
    versions = [version];
  } else {
    const from = current ? rangeStart(current, deps.version, state.previous) : undefined;
    const range = from && current ? versionsBetween(table, from, current) : [];
    versions = [...new Set([...(state.notesUnseen ?? []), ...range])].sort(compareVersions);
  }
  const shown: string[] = [];
  for (const v of versions) {
    const text = noteText(paths, table, v);
    if (!text) continue;
    deps.out(`${shown.length ? "\n" : ""}${text}`);
    shown.push(v);
  }
  if (shown.length === 0) deps.out(emptyMessage(version, current, deps.version, state.previous));
  const seen = new Set(versions);
  if (state.notesUnseen?.some((v) => seen.has(v))) {
    updateState(paths, (s) => {
      const left = (s.notesUnseen ?? []).filter((v) => !seen.has(v));
      const next: RuntimeState = { ...s, notesUnseen: left };
      if (left.length === 0) delete next.notesUnseen;
      return next;
    });
  }
  return 0;
}

function emptyMessage(
  version: string | undefined,
  current: string | undefined,
  running: string,
  previous: string | undefined,
): string {
  if (version) return `browxai ${version} has no Upgrading notes. Nothing to do.\n`;
  const from = current ? rangeStart(current, running, previous) : undefined;
  if (from && current) return `No Upgrading notes from ${from} to ${current}. Nothing to do.\n`;
  return `No unread Upgrading notes. browxai runtime notes V prints the notes of version V.\n`;
}

/**
 * The one standard error line a server prints on its first start of a version
 * with unseen notes, or undefined. It reads `BROWX_RUNTIME_DIR` and
 * `BROWX_RUNTIME_VERSION`, which the launcher sets, and remembers the start
 * with an empty marker file under `notes/`, created exclusively, so two servers
 * that start at once print it once. Any failure prints nothing.
 */
export function firstStartLine(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const root = env.BROWX_RUNTIME_DIR?.trim();
    const version = env.BROWX_RUNTIME_VERSION?.trim();
    if (!root || !isAbsolute(root) || !version || !isVersion(version)) return undefined;
    const paths = runtimePaths(root);
    if (!existsSync(paths.layout)) return undefined;
    const unseen = (readState(paths).notesUnseen ?? []).filter(
      (v) => compareVersions(v, version) <= 0,
    );
    if (unseen.length === 0) return undefined;
    mkdirSync(paths.notes, { recursive: true, mode: 0o700 });
    closeSync(openSync(join(paths.notes, `.started-${version}`), "wx", 0o600));
    if (unseen.length === 1 && unseen[0] === version) {
      return `browxai ${version} is new on this machine. Upgrading notes: browxai runtime notes ${version}\n`;
    }
    return `browxai ${version} is new on this machine, with Upgrading notes for ${unseen.join(", ")}. Read them: browxai runtime notes\n`;
  } catch {
    return undefined;
  }
}
