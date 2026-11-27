// `browxai runtime rollback [--to V]`: switch `current` to the previous version,
// or to any kept version, with no network. The version it leaves is held ("rolled
// back by user"), so the background job doesn't apply it again. That hold clears
// when a newer version is applied, or when `runtime update --version` names it.
// A rollback to a held version releases that version's hold.

import { existsSync } from "node:fs";
import { ROLLED_BACK } from "./runtime-guards.js";
import { appendJournal } from "./runtime-journal.js";
import { cliOf, compareVersions, versionDir, type RuntimePaths } from "./runtime-layout.js";
import {
  listVersions,
  readCurrent,
  readState,
  switchCurrent,
  writeState,
  type RuntimeState,
} from "./runtime-store.js";

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

function newer(a: string, b: string): boolean {
  try {
    return compareVersions(a, b) > 0;
  } catch {
    return false;
  }
}

/** The state after leaving `left` for `target`: `left` is held and becomes
 *  `previous`, and `target` loses any hold. */
function stateAfter(state: RuntimeState, target: string, left: string | undefined): RuntimeState {
  const held = { ...state.held };
  delete held[target];
  const next: RuntimeState = { ...state, held };
  if (left) {
    held[left] = ROLLED_BACK;
    next.previous = left;
  }
  // A version newer than the new `current` that is held shows as pending, so
  // doctor and status name the hold.
  if (left && newer(left, target))
    next.pending = { version: left, state: "held", reason: ROLLED_BACK };
  else if (next.pending?.version === target) delete next.pending;
  return next;
}

export function rollback(
  paths: RuntimePaths,
  to: string | undefined,
  io: Io,
  now: () => number = Date.now,
): number {
  const current = readCurrent(paths);
  const state = readState(paths);
  const target = to ?? state.previous;
  if (!target || (!to && target === current)) {
    io.err("browxai runtime: there is no previous version to roll back to. Nothing was changed.\n");
    return 1;
  }
  if (target === current) {
    io.out(`current is already ${target}. Nothing was changed.\n`);
    return 0;
  }
  if (!existsSync(cliOf(versionDir(paths, target)))) {
    const kept = listVersions(paths).join(", ") || "none";
    io.err(
      to
        ? `browxai runtime: ${to} is not a kept version (kept: ${kept}). Nothing was changed.\n`
        : `browxai runtime: ${cliOf(versionDir(paths, target))} is missing. Nothing was changed.\n`,
    );
    return 1;
  }
  switchCurrent(paths, target);
  writeState(paths, stateAfter(state, target, current));
  appendJournal(paths, {
    at: new Date(now()).toISOString(),
    mode: "manual",
    event: "rollback",
    version: target,
    ...(current ? { from: current, reason: `${current} ${ROLLED_BACK}` } : {}),
  });
  io.out(`✓ current is ${target}${current ? `, was ${current}` : ""}.\n`);
  if (current) {
    io.out(`  Servers already running keep ${current} until their MCP client starts them again.\n`);
    io.out(
      `  ${current} is held: the updater doesn't apply it again until a newer version appears. ` +
        `To apply it: browxai runtime update --version ${current}\n`,
    );
  }
  return 0;
}
