// `browxai runtime install` and `browxai runtime update`, the manual path.
// `install` also installs the background job that runs `update --auto` (see
// runtime-agent.ts and runtime-auto.ts), unless `--no-agent`.

import type { AgentPort } from "./runtime-agent.js";
import { applyVersion, selectVersion, type ApplyDeps } from "./runtime-apply.js";
import { enginesCheck } from "./runtime-guards.js";
import { clientInstructions, detectClients, type ClientSystem } from "./init-clients.js";
import {
  activeTargets,
  profileTargets,
  writeClientConfigs,
  type ClientTarget,
} from "./runtime-clients.js";
import { collectGarbage, renderGc, type ProcessLister } from "./runtime-gc.js";
import { appendJournal } from "./runtime-journal.js";
import { acquireLock } from "./runtime-lock.js";
import { recordNotes } from "./runtime-notes.js";
import { nextCheckAfter, type Random } from "./runtime-schedule.js";
import type { RuntimePaths } from "./runtime-layout.js";
import { findNpmCli, npmRegistry, type NpmContext, type Registry } from "./runtime-npm.js";
import type { Runner } from "./runtime-exec.js";
import { writeShim } from "./runtime-shim.js";
import {
  createLayout,
  readCurrent,
  readNodePath,
  readState,
  updateState,
  writeFileAtomic,
  type RuntimeState,
} from "./runtime-store.js";
import { linkLauncher } from "./runtime-link.js";
import {
  readSettingsFile,
  resolveMajorPolicy,
  writeSettingsFile,
  type Channel,
} from "./runtime-settings.js";

export interface FlowIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** What an install or update needs from the machine. Tests pass fakes. */
export interface FlowDeps {
  env: NodeJS.ProcessEnv;
  run: Runner;
  list: ProcessLister;
  /** The node this process runs on; `install` records it. */
  execPath: string;
  registry?: (npm: NpmContext) => Registry;
  verify?: ApplyDeps["verify"];
  smoke?: ApplyDeps["smoke"];
  findNpm?: (node: string) => string | undefined;
  system?: ClientSystem;
  clientWrite?: Parameters<typeof writeClientConfigs>[2]["apply"];
  /** The background job. Undefined where none can be installed. */
  agent?: AgentPort;
  now?: () => number;
  random?: Random;
}

/** The node for npm and the checks: BROWX_RUNTIME_NODE, then the recorded one,
 *  then this process's node. */
export function npmContext(paths: RuntimePaths, deps: FlowDeps): NpmContext | { error: string } {
  const node = deps.env.BROWX_RUNTIME_NODE?.trim() || readNodePath(paths) || deps.execPath;
  const npmCli = (deps.findNpm ?? findNpmCli)(node);
  if (!npmCli) {
    return {
      error:
        `no npm-cli.js next to ${node}. Set BROWX_RUNTIME_NODE to a node installed with npm, ` +
        "or run browxai runtime install from that node.",
    };
  }
  return { node, npmCli, run: deps.run, env: deps.env };
}

export interface UpdateWant {
  channel: Channel;
  version?: string;
  check?: boolean;
  /** `--allow-major`: a new major version is applied this once (D7). */
  allowMajor?: boolean;
}

/** Select, then apply. Exit 0 applied or nothing to do, 1 a failed check, 3 the
 *  registry unreachable. */
export async function updateFlow(
  paths: RuntimePaths,
  want: UpdateWant,
  deps: FlowDeps,
  io: FlowIo,
): Promise<number> {
  const lock = acquireLock(paths, deps.now ? { now: deps.now } : {});
  if (!lock.ok) {
    io.err(
      `browxai runtime: another update run (pid ${lock.pid}, started ${lock.startedAt}) holds ${paths.lock}. current is unchanged.\n`,
    );
    return 1;
  }
  try {
    // The launcher is this version's text, so a launcher fix reaches a runtime
    // with the first update that runs the fixed code.
    writeShim(paths);
    return await manualUpdate(paths, want, deps, io);
  } finally {
    lock.release();
  }
}

/** A manual check counts as a check: the background job's next contact moves 6 hours on. */
function recordManualCheck(paths: RuntimePaths, deps: FlowDeps, result: string): void {
  const now = (deps.now ?? Date.now)();
  updateState(paths, (s) => {
    const next: RuntimeState = {
      ...s,
      lastCheck: new Date(now).toISOString(),
      nextCheck: nextCheckAfter(now, deps.random ?? Math.random),
      lastResult: result,
    };
    delete next.backoffUntil;
    delete next.backoffMs;
    return next;
  });
}

function journalManual(
  paths: RuntimePaths,
  deps: FlowDeps,
  entry: Omit<Parameters<typeof appendJournal>[1], "at" | "mode">,
): void {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  appendJournal(paths, { at, mode: "manual", ...entry });
}

async function manualUpdate(
  paths: RuntimePaths,
  want: UpdateWant,
  deps: FlowDeps,
  io: FlowIo,
): Promise<number> {
  const npm = npmContext(paths, deps);
  if ("error" in npm) {
    io.err(`browxai runtime: ${npm.error}\n`);
    return 2;
  }
  const registry = (deps.registry ?? npmRegistry)(npm);
  const major = resolveMajorPolicy(readSettingsFile(paths).file);
  if (major.warning) io.err(`warning: ${major.warning}\n`);
  const selected = await selectVersion(paths, registry, want, {
    allowMajor: want.allowMajor === true || major.allow,
    engines: enginesCheck(npm),
  });
  if (selected.kind === "error") {
    journalManual(paths, deps, {
      event: selected.code === 3 ? "offline" : "error",
      reason: selected.message,
    });
    io.err(`browxai runtime: ${selected.message}. current is unchanged.\n`);
    return selected.code;
  }
  if (selected.kind === "none") {
    recordManualCheck(paths, deps, selected.message);
    journalManual(paths, deps, { event: "check", result: selected.message });
    io.out(`${selected.message}\n`);
    return 0;
  }
  if (selected.kind === "held") {
    const v = selected.info.version;
    recordManualCheck(paths, deps, `${v} held: ${selected.reason}`);
    updateState(paths, (s) => ({
      ...s,
      pending: { version: v, state: "held", reason: selected.reason },
    }));
    journalManual(paths, deps, { event: "check", version: v, result: `held: ${selected.reason}` });
    io.out(`${selected.message}\n`);
    return 0;
  }
  recordManualCheck(paths, deps, `${selected.info.version} found`);
  for (const w of selected.warnings) io.err(`warning: ${w}\n`);
  const v = selected.info.version;
  if (want.check) {
    io.out(
      `would install ${v}${selected.current ? ` over ${selected.current}` : ""}. Nothing was downloaded.\n`,
    );
    return 0;
  }
  io.out(`browxai runtime: applying ${v}\n`);
  const applied = await applyVersion(paths, selected.info, {
    registry,
    npm,
    ...(deps.verify ? { verify: deps.verify } : {}),
    ...(deps.smoke ? { smoke: deps.smoke } : {}),
    named: want.version !== undefined,
    out: io.out,
  });
  if (!applied.ok && applied.held) {
    journalManual(paths, deps, {
      event: "apply",
      version: v,
      result: "held",
      reason: applied.held,
    });
    updateState(paths, (s) => ({
      ...s,
      lastResult: `${v} held: ${applied.held}`,
      pending: { version: v, state: "held", reason: applied.held! },
    }));
    io.out(`${v} is held: ${applied.held}. current stays ${readCurrent(paths) ?? "unset"}.\n`);
    return 0;
  }
  if (!applied.ok) {
    journalManual(paths, deps, {
      event: "apply",
      version: v,
      result: "failed",
      reason: applied.reason,
    });
    updateState(paths, (s) => ({ ...s, lastResult: `${v} failed: ${applied.reason}` }));
    io.err(
      `✗ ${v} was not applied: ${applied.reason}. current is ${readCurrent(paths) ?? "not set"}.\n`,
    );
    return 1;
  }
  journalManual(paths, deps, {
    event: "apply",
    version: v,
    ...(applied.previous ? { from: applied.previous } : {}),
    ...(selected.info.integrity ? { integrity: selected.info.integrity } : {}),
    result: "applied",
  });
  updateState(paths, (s) => {
    const next: RuntimeState = { ...s, lastResult: `applied ${v}` };
    if (next.pending && next.pending.version === v) delete next.pending;
    delete next.currentDeprecated;
    return next;
  });
  io.out(
    `✓ current is ${v}${applied.previous ? `, was ${applied.previous}` : ""}. ` +
      "Each MCP client runs it from its next start. Servers already running keep their version.\n",
  );
  const notes = recordNotes(paths, applied.previous, v, (deps.now ?? Date.now)(), "manual");
  if (notes.length) io.out(`Upgrading notes for ${notes.join(", ")}: browxai runtime notes\n`);
  const gc = await collectGarbage(paths, readState(paths), { list: deps.list });
  if (gc.removed.length || gc.inUse.length || gc.unknown) io.out(renderGc(gc));
  return 0;
}

export interface InstallWant {
  channel: Channel;
  /** Set when `--channel` was given: it is written to runtime.json. */
  channelFlag?: Channel;
  writeClientConfig: boolean;
  profileDirs: string[];
  /** Install the background job. */
  agent: boolean;
  /** `--link`: the home directory whose ~/.local/bin gets a link to the launcher. */
  linkHome?: string;
}

export async function installFlow(
  paths: RuntimePaths,
  want: InstallWant,
  deps: FlowDeps,
  io: FlowIo,
): Promise<number> {
  const npmCli = (deps.findNpm ?? findNpmCli)(deps.execPath);
  if (!npmCli) {
    io.err(
      `browxai runtime: no npm-cli.js next to ${deps.execPath}. Install Node with npm, then run this again.\n`,
    );
    return 2;
  }
  createLayout(paths);
  writeFileAtomic(paths.nodePath, deps.execPath + "\n");
  writeShim(paths);
  if (want.channelFlag) writeSettingsFile(paths, { channel: want.channelFlag });
  io.out(
    `browxai runtime at ${paths.root}\n  launcher: ${paths.shim}\n  node:     ${deps.execPath}\n`,
  );
  const code = await updateFlow(paths, { channel: want.channel }, deps, io);
  if (readCurrent(paths) === undefined) return code === 0 ? 1 : code;
  if (want.agent) await installAgent(paths, deps, io);
  else await removeAgent(deps, io);
  if (want.linkHome !== undefined) linkLauncher(paths, { home: want.linkHome, env: deps.env }, io);
  io.out(clientEntries(paths, deps.system));
  if (!want.writeClientConfig) return code;
  const targets: ClientTarget[] = [
    ...(deps.system ? activeTargets(deps.system) : []),
    ...want.profileDirs.flatMap((d) => profileTargets(d)),
  ];
  if (targets.length === 0) io.out("No client config to rewrite was found.\n");
  const ok = writeClientConfigs(targets, paths.shim, {
    out: io.out,
    ...(deps.clientWrite ? { apply: deps.clientWrite } : {}),
  });
  return ok ? code : 1;
}

/** Install the background job. A job that can't be loaded leaves the install
 *  in place and says how to update by hand. */
async function installAgent(paths: RuntimePaths, deps: FlowDeps, io: FlowIo): Promise<void> {
  const node = readNodePath(paths) ?? deps.execPath;
  if (!deps.agent?.kind) {
    io.out("No background job on this platform. Run browxai runtime update to update.\n");
    return;
  }
  const r = await deps.agent.install(paths, node);
  if (r.ok) {
    io.out(`✓ background job: ${r.detail}. It runs browxai runtime update --auto every hour.\n`);
    io.out(
      "  Turn it off: browxai runtime config auto-update off, or run install again with --no-agent.\n",
    );
  } else {
    io.err(
      `warning: the background job was not installed: ${r.detail}. Run browxai runtime update to update.\n`,
    );
  }
}

/** `--no-agent` on a runtime that has a job removes it. */
async function removeAgent(deps: FlowDeps, io: FlowIo): Promise<void> {
  if (!deps.agent || deps.agent.installed().length === 0) return;
  const r = await deps.agent.remove();
  io.out(`background job: ${r.detail}\n`);
}

function clientEntries(paths: RuntimePaths, system: ClientSystem | undefined): string {
  const entry = { command: paths.shim, args: [], env: {} };
  const found = system ? detectClients(system) : [];
  const blocks = found.map((id) => clientInstructions(id, entry, system!));
  return (
    `\nClient entries name the launcher ${paths.shim}, so they follow updates with no edit.\n` +
    "An entry you already have keeps its env: set its command to the launcher and its args to [],\n" +
    'or to the subcommand it runs, such as ["bridge", "--socket", PATH].\n' +
    (blocks.length ? `\n${blocks.join("\n\n")}\n` : "") +
    "\nRun install again with --write-client-config to rewrite entries that run an installed browxai\n" +
    "or npx browxai in the active config of each client. Add --profile-dir DIR for each further config directory.\n"
  );
}
