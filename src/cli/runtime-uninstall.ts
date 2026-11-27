// `browxai runtime uninstall [--keep-versions] [--yes]`: remove the background
// job, the `~/.local/bin` link when it points at this launcher, and the runtime
// directory. It refuses while a process runs from one of the versions, unless
// `--yes`. `--keep-versions` removes the launcher, `current`, the settings, the
// state, the journal and the notes, and keeps `versions/` and `layout.json`:
// servers already running keep their files, and a later `runtime install` finds
// the kept versions and switches to one with no download. It never touches
// `$BROWX_WORKSPACE`, and it names the client configs that still point at the
// launcher.

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ClientSystem } from "./init-clients.js";
import type { AgentPort } from "./runtime-agent.js";
import { activeTargets } from "./runtime-clients.js";
import { versionsInUse, type ProcessLister } from "./runtime-gc.js";
import { unlinkLauncher } from "./runtime-link.js";
import type { RuntimePaths } from "./runtime-layout.js";
import { listVersions } from "./runtime-store.js";

export interface UninstallDeps {
  list: ProcessLister;
  agent?: AgentPort;
  system?: ClientSystem;
  /** The home directory whose `~/.local/bin` may hold a link to the launcher. */
  home: string;
}

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** What `--keep-versions` leaves in the runtime directory. */
const KEPT = new Set(["versions", "layout.json"]);

export async function uninstall(
  paths: RuntimePaths,
  opts: { yes: boolean; keepVersions: boolean },
  deps: UninstallDeps,
  io: Io,
): Promise<number> {
  if (!opts.keepVersions && !opts.yes) {
    const refusal = await inUseRefusal(paths, deps.list);
    if (refusal) {
      io.err(`browxai runtime: ${refusal}\n`);
      return 2;
    }
  }
  if (deps.agent && deps.agent.installed().length > 0) {
    const removed = await deps.agent.remove();
    io.out(`✓ background job: ${removed.detail}\n`);
  }
  const unlinked = unlinkLauncher(paths, deps.home);
  if (unlinked) io.out(`✓ removed the link ${unlinked}\n`);
  if (opts.keepVersions) {
    for (const name of readdirSync(paths.root)) {
      if (!KEPT.has(name)) rmSync(join(paths.root, name), { recursive: true, force: true });
    }
    const kept = listVersions(paths);
    io.out(
      `✓ removed the launcher, settings and state from ${paths.root}. ` +
        `Kept versions/ (${kept.join(", ") || "empty"}) and layout.json: ` +
        "browxai runtime install reuses them, and browxai runtime uninstall removes the rest.\n",
    );
  } else {
    rmSync(paths.root, { recursive: true, force: true });
    io.out(`✓ removed ${paths.root}\n`);
  }
  const still = leftoverConfigs(paths, deps.system);
  if (still.length) {
    io.out(
      `These client configs still name ${paths.shim}. Point their entries at another browxai:\n`,
    );
    for (const p of still) io.out(`  ${p}\n`);
  }
  return 0;
}

/** Why the runtime can't be removed now, or undefined when nothing runs from it. */
async function inUseRefusal(paths: RuntimePaths, list: ProcessLister): Promise<string | undefined> {
  const use = await versionsInUse(paths, list);
  if (!use) {
    return "the process list could not be read, so it is unknown whether a server runs from this runtime. Pass --yes to remove it anyway, or --keep-versions.";
  }
  if (use.size === 0) return undefined;
  const pids = [...use.values()].flat().join(", ");
  return `pid ${pids} runs from ${paths.root}. Stop those servers first, or pass --yes or --keep-versions. Nothing was changed.`;
}

function leftoverConfigs(paths: RuntimePaths, system: ClientSystem | undefined): string[] {
  if (!system) return [];
  return activeTargets(system)
    .map((t) => t.path)
    .filter((p) => {
      try {
        return readFileSync(p, "utf8").includes(paths.shim);
      } catch {
        return false;
      }
    });
}
