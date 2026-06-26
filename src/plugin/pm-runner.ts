// Package-manager process driver for the `browxai plugin` CLI — detection
// (`detectPackageManager`), the operation→argv translation (`pmArgs`), and the
// `spawn`-based runner (`runPm`) that drives `pnpm`/`npm` against the
// workspace-rooted install dir. Split out of `cli.ts` so the CLI command
// surface keeps only the verb handlers; the per-manager verb mapping itself
// lives in the add-only `package-manager.ts` adapter registry.
//
// Leaf module: imports the adapter registry + node stdlib + logging. It MUST
// NOT import from `./cli.js` (the barrel that re-exports it) — that would be an
// import cycle.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util/logging.js";
import { type PluginPaths } from "./resolver.js";
import {
  packageManagerAdapter,
  packageManagerAdaptersByPriority,
  type PackageManager,
  type PmOperation,
} from "./package-manager.js";

// RFC 0004 P4 / D6 — the per-manager verb mapping moved to an add-only
// `PackageManagerAdapter` registry (`package-manager.ts`); `pmArgs` /
// `detectPackageManager` now resolve through it. Re-exported here so callers
// (incl. the CLI tests) keep importing `PackageManager` / `PmOperation` from
// `./cli.js` unchanged.
export type { PackageManager, PmOperation } from "./package-manager.js";

/** Emitted when neither pnpm nor npm is on PATH — actionable, names the
 *  requirement. Exported for the CLI tests. */
export const NO_PACKAGE_MANAGER_ERROR =
  "browxai plugin: no package manager found. Managing workspace plugins requires `pnpm` (preferred) or `npm` on PATH — install one (https://pnpm.io/installation or https://nodejs.org) and re-run.";

function canSpawn(cmd: string): boolean {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

/**
 * Probe for an available package manager. The adapters are walked in ascending
 * probe priority (pnpm at 0 wins — it is the project's declared manager and what
 * CI uses; npm at 1 is the fallback so `npm install -g browxai` adopters aren't
 * dead-ended with a bare ENOENT). Returns null when none is on PATH. Adding a
 * manager is a new adapter registration, not an edit here.
 */
export function detectPackageManager(
  probe: (cmd: string) => boolean = canSpawn,
): PackageManager | null {
  for (const adapter of packageManagerAdaptersByPriority()) {
    if (probe(adapter.name)) return adapter.name;
  }
  return null;
}

/** Translate an operation (+ optional target spec) into manager argv. */
export function pmArgs(
  pm: PackageManager,
  op: PmOperation,
  target?: string,
): ReadonlyArray<string> {
  const adapter = packageManagerAdapter(pm);
  if (!adapter)
    throw new Error(`browxai plugin: no adapter registered for package manager "${pm}"`);
  const verb = adapter.verbs[op];
  return target === undefined ? [verb] : [verb, target];
}

export async function runPm(paths: PluginPaths, op: PmOperation, target?: string): Promise<number> {
  const pm = detectPackageManager();
  if (pm === null) {
    process.stderr.write(`${NO_PACKAGE_MANAGER_ERROR}\n`);
    return 127;
  }
  // paths.installDir is workspace-rooted by construction (see
  // pluginPaths() in resolver.ts — `<workspace>/plugins/`).
  mkdirSync(paths.installDir, { recursive: true });
  // Create a stub package.json so the manager has a project root to write into.
  const stub = join(paths.installDir, "package.json");
  if (!existsSync(stub)) {
    writeFileSync(
      stub,
      JSON.stringify({ name: "browxai-plugins", version: "0.0.0", private: true }, null, 2) + "\n",
      "utf8",
    );
  }
  const args = pmArgs(pm, op, target);
  return new Promise<number>((resolve) => {
    const child = spawn(pm, [...args], {
      cwd: paths.installDir,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      log.error(`browxai plugin: ${pm} spawn failed — ${err.message}`);
      process.stderr.write(`${NO_PACKAGE_MANAGER_ERROR}\n`);
      resolve(127);
    });
  });
}
