// `browxai runtime install` and `browxai runtime update`, the manual path. No
// background job: S1 of RFC 0015 updates only when the user runs one of these.

import { applyVersion, selectVersion, type ApplyDeps } from "./runtime-apply.js";
import { clientInstructions, detectClients, type ClientSystem } from "./init-clients.js";
import {
  activeTargets,
  profileTargets,
  writeClientConfigs,
  type ClientTarget,
} from "./runtime-clients.js";
import { collectGarbage, renderGc, type ProcessLister } from "./runtime-gc.js";
import type { RuntimePaths } from "./runtime-layout.js";
import { findNpmCli, npmRegistry, type NpmContext, type Registry } from "./runtime-npm.js";
import type { Runner } from "./runtime-exec.js";
import { writeShim } from "./runtime-shim.js";
import {
  createLayout,
  readCurrent,
  readNodePath,
  readState,
  writeFileAtomic,
} from "./runtime-store.js";
import { writeSettingsFile, type Channel } from "./runtime-settings.js";

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
}

/** Select, then apply. Exit 0 applied or nothing to do, 1 a failed check, 3 the
 *  registry unreachable. */
export async function updateFlow(
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
  const selected = await selectVersion(paths, registry, want);
  if (selected.kind === "error") {
    io.err(`browxai runtime: ${selected.message}. current is unchanged.\n`);
    return selected.code;
  }
  if (selected.kind === "none") {
    io.out(`${selected.message}\n`);
    return 0;
  }
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
    out: io.out,
  });
  if (!applied.ok) {
    io.err(
      `✗ ${v} was not applied: ${applied.reason}. current is ${readCurrent(paths) ?? "not set"}.\n`,
    );
    return 1;
  }
  io.out(
    `✓ current is ${v}${applied.previous ? `, was ${applied.previous}` : ""}. ` +
      "Each MCP client runs it from its next start. Servers already running keep their version.\n",
  );
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
