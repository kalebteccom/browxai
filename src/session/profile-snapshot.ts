// Profile snapshot / restore (W-S3) — the `unstable` lane.
//
// A destructive authenticated-SPA test mutates the persistent profile (an
// accidental timeline edit, a half-finished form, dirty local state). Repeat
// runs then start from a polluted baseline. This copies a session's profile
// directory to/from a named snapshot under the workspace, so a test can
// checkpoint a clean state and restore it between runs.
//
// Copying a profile dir while Chromium has it open yields a corrupt copy
// (locked SQLite, in-flight writes) — the caller MUST close sessions first;
// the server tool enforces that guard.

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

// mnemonic / profile names — no path separators or traversal.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function checkName(kind: string, name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`${kind} "${name}" invalid — use only letters, digits, '.', '_', '-' (no path separators)`);
  }
}

/** The on-disk dir for a session profile. `default`/undefined → `<root>/profile`
 *  (the legacy single-profile path); a name → `<root>/profiles/<name>`. */
function profileDir(workspaceRoot: string, profile: string | undefined): string {
  if (!profile || profile === "default") return join(workspaceRoot, "profile");
  checkName("profile", profile);
  return join(workspaceRoot, "profiles", profile);
}

function snapshotDir(workspaceRoot: string, snapshot: string): string {
  checkName("snapshot", snapshot);
  return join(workspaceRoot, "profile-snapshots", snapshot);
}

export interface ProfileSnapshotResult {
  ok: boolean;
  action: "snapshot" | "restore";
  profile: string;
  snapshot: string;
}

/** Copy a profile directory into a named snapshot (overwrites an existing
 *  snapshot of the same name). */
export function snapshotProfile(
  workspaceRoot: string,
  profile: string | undefined,
  snapshot: string,
): ProfileSnapshotResult {
  const src = profileDir(workspaceRoot, profile);
  const dest = snapshotDir(workspaceRoot, snapshot);
  if (!existsSync(src)) {
    throw new Error(`profile_snapshot: no profile directory at "${src}" — open a persistent session with this profile first`);
  }
  cpSync(src, dest, { recursive: true, force: true });
  return { ok: true, action: "snapshot", profile: profile ?? "default", snapshot };
}

/** Restore a named snapshot back over a profile directory. */
export function restoreProfile(
  workspaceRoot: string,
  profile: string | undefined,
  snapshot: string,
): ProfileSnapshotResult {
  const src = snapshotDir(workspaceRoot, snapshot);
  const dest = profileDir(workspaceRoot, profile);
  if (!existsSync(src)) {
    throw new Error(`profile_restore: no snapshot "${snapshot}" — take one with profile_snapshot first`);
  }
  cpSync(src, dest, { recursive: true, force: true });
  return { ok: true, action: "restore", profile: profile ?? "default", snapshot };
}
