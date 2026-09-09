// Profile inventory — capability `read`.
//
// Answers "what is in <workspace>/profiles, how stale is each one, and which of
// them is open right now". Deliberately does NOT answer "which profile is
// logged in to <origin>": Chromium's cookie store is SQLite whose values are
// encrypted with an OS-provided key (Keychain / DPAPI), so nothing short of
// launching the browser can read them. Every origin-ish field this module emits
// is therefore labelled with where it came from and when it was true.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertSafeName, isSafeName, resolveWorkspacePath } from "../util/workspace.js";

const TOOL = "profile_status";
const PROFILES_SUBDIR = "profiles";
const AUTH_STATES_SUBDIR = ".auth-states";

/** `<root>/profile` — the single-profile dir the default session still uses.
 *  Addressed as the profile name `default`, matching `profile_snapshot`. */
const LEGACY_PROFILE_SUBDIR = "profile";
const LEGACY_PROFILE_NAME = "default";

/** Whole-call ceiling on directory entries the size/mtime walk visits. A
 *  workspace that accumulated a hundred-plus Chromium profiles holds millions of
 *  files; without a budget this read tool would block the agent loop for
 *  minutes. A row whose walk stopped here carries `scanTruncated`, so a partial
 *  number is never presented as an exact one. */
export const MAX_SCAN_ENTRIES = 50_000;

export interface ProfileLiveState {
  /** Live session ids currently running out of this profile directory. */
  sessions: string[];
  /** Cookie domains the open browser context holds RIGHT NOW. Absent when the
   *  engine has no queryable context. Presence of a domain means cookies exist,
   *  not that any of them authenticate. */
  cookieDomains?: string[];
  observedAt: string;
}

export interface ProfileSavedAuthState {
  name: string;
  path: string;
  savedAt: string;
  cookieDomains: string[];
  originsWithLocalStorage: string[];
}

export interface ProfileStatusRow {
  name: string;
  path: string;
  bytes: number;
  files: number;
  modifiedAt: string;
  /** The entry budget ran out mid-walk — `bytes` / `files` / `modifiedAt` are
   *  lower bounds for this row. */
  scanTruncated?: true;
  live?: ProfileLiveState;
  savedAuthState?: ProfileSavedAuthState;
}

export interface ProfileStatusResult {
  profilesRoot: string;
  profiles: ProfileStatusRow[];
  warnings: string[];
}

/** One live session, reduced to what the inventory needs. The caller supplies
 *  the cookie read as a thunk so this module stays free of Playwright. */
export interface LiveProfileProbe {
  sessionId: string;
  /** The on-disk directory the session launched with. */
  profileDir: string;
  cookieDomains: () => Promise<string[]>;
}

/** The on-disk dir for a profile name. Both the traversal chokepoint and the
 *  single-segment name rule apply: the first rejects a name that escapes
 *  `$BROWX_WORKSPACE`, the second rejects one that stays inside but carries a
 *  separator or a dot-special. */
export function profileDirFor(workspaceRoot: string, name: string): string {
  const relative =
    name === LEGACY_PROFILE_NAME ? LEGACY_PROFILE_SUBDIR : join(PROFILES_SUBDIR, name);
  const resolved = resolveWorkspacePath(workspaceRoot, relative, TOOL);
  assertSafeName("profile", name);
  return resolved;
}

interface ScanBudget {
  remaining: number;
}

interface DirScan {
  bytes: number;
  files: number;
  newestMs: number;
  truncated: boolean;
}

function accumulateFile(path: string, scan: DirScan): void {
  try {
    const st = statSync(path);
    scan.bytes += st.size;
    scan.files += 1;
    if (st.mtimeMs > scan.newestMs) scan.newestMs = st.mtimeMs;
  } catch {
    /* raced away mid-walk */
  }
}

/** Iterative (no recursion, no symlink following) size + newest-mtime walk,
 *  bounded by the shared entry budget. Symlinks are skipped rather than
 *  followed: one could point outside the workspace or back into the tree. */
function scanDir(dir: string, budget: ScanBudget): DirScan {
  const scan: DirScan = { bytes: 0, files: 0, newestMs: 0, truncated: false };
  try {
    scan.newestMs = statSync(dir).mtimeMs;
  } catch {
    return scan;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget.remaining <= 0) {
        scan.truncated = true;
        return scan;
      }
      budget.remaining -= 1;
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) accumulateFile(path, scan);
    }
  }
  return scan;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function arrayField(record: unknown, key: string): unknown[] {
  if (!record || typeof record !== "object") return [];
  const value = (record as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

/** The `auth_save` slot whose name equals the profile name, if there is one.
 *  browxai does not record which profile a slot was captured from, so the only
 *  link is the matching name — the caller-facing description says so. */
function savedAuthStateFor(workspaceRoot: string, name: string): ProfileSavedAuthState | undefined {
  const path = resolveWorkspacePath(workspaceRoot, join(AUTH_STATES_SUBDIR, `${name}.json`), TOOL);
  if (!existsSync(path)) return undefined;
  try {
    const savedAt = new Date(statSync(path).mtimeMs).toISOString();
    const blob: unknown = JSON.parse(readFileSync(path, "utf8"));
    return {
      name,
      path,
      savedAt,
      cookieDomains: uniqueSorted(
        arrayField(blob, "cookies")
          .map((c) => stringField(c, "domain"))
          .filter((d): d is string => d !== undefined),
      ),
      originsWithLocalStorage: uniqueSorted(
        arrayField(blob, "origins")
          .map((o) => stringField(o, "origin"))
          .filter((o): o is string => o !== undefined),
      ),
    };
  } catch {
    return undefined;
  }
}

/** Every profile directory in the workspace, as `{name, path}`. The legacy
 *  `<root>/profile` dir is listed under the name `default`. */
function discoverProfiles(workspaceRoot: string): Array<{ name: string; path: string }> {
  const found: Array<{ name: string; path: string }> = [];
  const legacy = join(workspaceRoot, LEGACY_PROFILE_SUBDIR);
  if (isDirectory(legacy)) found.push({ name: LEGACY_PROFILE_NAME, path: legacy });
  const root = join(workspaceRoot, PROFILES_SUBDIR);
  if (!existsSync(root)) return found;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeName(entry.name)) continue;
    found.push({ name: entry.name, path: join(root, entry.name) });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function liveStateFor(
  path: string,
  probes: readonly LiveProfileProbe[],
): Promise<ProfileLiveState | undefined> {
  const here = probes.filter((p) => p.profileDir === path);
  if (here.length === 0) return undefined;
  const state: ProfileLiveState = {
    sessions: here.map((p) => p.sessionId).sort((a, b) => a.localeCompare(b)),
    observedAt: new Date().toISOString(),
  };
  const domains: string[] = [];
  for (const probe of here) {
    try {
      domains.push(...(await probe.cookieDomains()));
    } catch {
      return state;
    }
  }
  state.cookieDomains = uniqueSorted(domains);
  return state;
}

async function buildRow(
  workspaceRoot: string,
  profile: { name: string; path: string },
  probes: readonly LiveProfileProbe[],
  budget: ScanBudget,
): Promise<ProfileStatusRow> {
  const scan = scanDir(profile.path, budget);
  const live = await liveStateFor(profile.path, probes);
  const savedAuthState = savedAuthStateFor(workspaceRoot, profile.name);
  return {
    name: profile.name,
    path: profile.path,
    bytes: scan.bytes,
    files: scan.files,
    modifiedAt: new Date(scan.newestMs).toISOString(),
    ...(scan.truncated ? { scanTruncated: true as const } : {}),
    ...(live ? { live } : {}),
    ...(savedAuthState ? { savedAuthState } : {}),
  };
}

/** Inventory every profile directory (or just `opts.profile`). A missing
 *  profiles root is an empty inventory, not an error. */
export async function profileStatus(
  workspaceRoot: string,
  probes: readonly LiveProfileProbe[],
  opts: { profile?: string; maxEntries?: number } = {},
): Promise<ProfileStatusResult> {
  const warnings: string[] = [];
  const discovered =
    opts.profile === undefined
      ? discoverProfiles(workspaceRoot)
      : [{ name: opts.profile, path: profileDirFor(workspaceRoot, opts.profile) }].filter((p) =>
          isDirectory(p.path),
        );
  if (discovered.filter((p) => p.name === LEGACY_PROFILE_NAME).length > 1) {
    warnings.push(
      `two directories are named "${LEGACY_PROFILE_NAME}" — <workspace>/${LEGACY_PROFILE_SUBDIR} ` +
        `and <workspace>/${PROFILES_SUBDIR}/${LEGACY_PROFILE_NAME}. Tools that take a \`profile\` ` +
        `name resolve "${LEGACY_PROFILE_NAME}" to the former; the latter is reachable only as the ` +
        `default session's own directory. Read each row's \`path\` to tell them apart.`,
    );
  }
  const budget: ScanBudget = { remaining: opts.maxEntries ?? MAX_SCAN_ENTRIES };
  const profiles: ProfileStatusRow[] = [];
  for (const profile of discovered) {
    profiles.push(await buildRow(workspaceRoot, profile, probes, budget));
  }
  return { profilesRoot: join(workspaceRoot, PROFILES_SUBDIR), profiles, warnings };
}
