// `browxai runtime <verb>`: manage a runtime directory that keeps browxai
// releases side by side under one launcher path. See
// docs/rfcs/0015-runtime-updates.md. Exit codes follow the shell route: 0 ok,
// 1 a failed check or an internal error, 2 usage or a refused context, 3 the
// npm registry could not be reached.

import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realSystem, type ClientSystem } from "./init-clients.js";
import { runningAppBundle } from "./macos-app.js";
import { parseRuntimeArgs, RUNTIME_USAGE, type RuntimeArgs } from "./runtime-args.js";
import { systemAgent, type AgentPort } from "./runtime-agent.js";
import { autoUpdateFlow, systemBootTime, type AutoClock } from "./runtime-auto.js";
import { activeTargets } from "./runtime-clients.js";
import { runProgram } from "./runtime-exec.js";
import {
  collectGarbage,
  renderGc,
  systemProcessLister,
  versionsInUse,
  type ProcessLister,
} from "./runtime-gc.js";
import { installFlow, updateFlow, type FlowDeps } from "./runtime-install.js";
import { appendJournal } from "./runtime-journal.js";
import {
  cliOf,
  inspectRuntime,
  realContext,
  resolveRuntimeDir,
  runtimePaths,
  versionDir,
  type RuntimeContext,
  type RuntimePaths,
} from "./runtime-layout.js";
import { readSettingsFile, resolveChannel, type Channel } from "./runtime-settings.js";
import { renderStatus, runtimeStatus } from "./runtime-status.js";
import { readCurrent, readState, switchCurrent, writeState } from "./runtime-store.js";

export { RUNTIME_USAGE } from "./runtime-args.js";

/** Seams a test can replace. */
export interface RuntimeDeps extends Partial<Omit<FlowDeps, "env" | "list" | "agent">> {
  ctx?: RuntimeContext;
  list?: ProcessLister;
  /** The background job. Tests pass a fake: the real one loads launchd or systemd units. */
  agent?: AgentPort;
  /** The clock and boot time `update --auto` reads. */
  clock?: Partial<AutoClock>;
  /** The Browxai app this process runs from, or undefined outside it. */
  appBundle?: () => string | undefined;
  /** The real path of the `cli.js` this process runs. */
  selfCli?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const APP_MESSAGE =
  "browxai runtime: this browxai is the signed Browxai app, which updates through Homebrew: brew upgrade --cask browxai\n";

export async function runRuntime(args: readonly string[], deps: RuntimeDeps = {}): Promise<number> {
  const io: Io = {
    out: deps.out ?? ((t) => process.stdout.write(t)),
    err: deps.err ?? ((t) => process.stderr.write(t)),
  };
  const parsed = parseRuntimeArgs(args);
  if (!parsed) {
    io.err(RUNTIME_USAGE);
    return 2;
  }
  // The signed app runs only its own sealed code and updates through Homebrew.
  if ((deps.appBundle ?? runningAppBundle)() !== undefined) {
    io.err(APP_MESSAGE);
    return 2;
  }
  const ctx = deps.ctx ?? realContext();
  const dir = resolveRuntimeDir(ctx, parsed.verb === "install" ? parsed.dir : undefined);
  if ("error" in dir) return refuse(io, dir.error);
  const checked = inspectRuntime(dir.dir, ctx, parsed.verb !== "status");
  if (!checked.ok) return refuse(io, checked.reason);
  const paths = runtimePaths(dir.dir);
  const run = deps.run ?? runProgram;
  const list = deps.list ?? systemProcessLister(run, ctx.platform);
  const agent =
    deps.agent ??
    systemAgent({ platform: ctx.platform, home: ctx.home, uid: ctx.uid, env: ctx.env, run });
  if (parsed.verb === "status") {
    const status = await runtimeStatus(paths, checked.found, {
      env: ctx.env,
      list,
      selfCli: deps.selfCli ?? selfCliPath(),
      agentInstalled: () => agent.installed(),
    });
    io.out(parsed.json ? JSON.stringify(status, null, 2) + "\n" : renderStatus(status));
    return 0;
  }
  const flow: FlowDeps & { clock: AutoClock } = {
    ...deps,
    env: ctx.env,
    run,
    list,
    execPath: deps.execPath ?? process.execPath,
    system: deps.system ?? realSystem(),
    agent,
    clock: {
      now: deps.clock?.now ?? deps.now ?? Date.now,
      random: deps.clock?.random ?? deps.random ?? Math.random,
      bootTime: deps.clock?.bootTime ?? systemBootTime(run, ctx.platform),
    },
  };
  flow.now = flow.clock.now;
  flow.random = flow.clock.random;
  if (parsed.verb === "install") return install(paths, parsed, flow, io);
  if (checked.found.kind !== "managed") {
    return refuse(io, `no browxai runtime at ${dir.dir}. Run: browxai runtime install`);
  }
  return managedVerb(paths, parsed, flow, io);
}

function managedVerb(
  paths: RuntimePaths,
  parsed: RuntimeArgs,
  flow: FlowDeps & { clock: AutoClock },
  io: Io,
): Promise<number> | number {
  if (parsed.verb === "rollback") return rollback(paths, io);
  if (parsed.verb === "gc") return gc(paths, flow.list, io);
  if (parsed.verb === "uninstall") return uninstall(paths, parsed.yes, flow, io);
  if (parsed.verb !== "update") return refuse(io, RUNTIME_USAGE);
  if (parsed.auto) return autoUpdateFlow(paths, { skipDelay: parsed.now }, flow, io);
  const channel = channelOf(paths, flow.env, io);
  if (!channel) return 2;
  const want = {
    channel,
    check: parsed.check,
    ...(parsed.version ? { version: parsed.version } : {}),
  };
  return updateFlow(paths, want, flow, io);
}

function refuse(io: Io, reason: string): number {
  io.err(`browxai runtime: ${reason}${reason.endsWith("\n") ? "" : "\n"}`);
  return 2;
}

/** The channel from BROWX_RUNTIME_CHANNEL or runtime.json; undefined after
 *  printing why it can't be used. */
function channelOf(paths: RuntimePaths, env: NodeJS.ProcessEnv, io: Io): Channel | undefined {
  const { file, error } = readSettingsFile(paths);
  if (error) {
    refuse(io, `${error}. Fix it or remove it.`);
    return undefined;
  }
  const channel = resolveChannel(env, file);
  if (!channel.ok) {
    refuse(io, channel.error);
    return undefined;
  }
  return channel.value;
}

function install(
  paths: RuntimePaths,
  parsed: Extract<RuntimeArgs, { verb: "install" }>,
  flow: FlowDeps,
  io: Io,
): Promise<number> | number {
  const channel = parsed.channel ?? channelOf(paths, flow.env, io);
  if (!channel) return 2;
  const want = {
    channel,
    ...(parsed.channel ? { channelFlag: parsed.channel } : {}),
    writeClientConfig: parsed.writeClientConfig,
    profileDirs: parsed.profileDirs,
    agent: !parsed.noAgent,
  };
  return installFlow(paths, want, flow, io);
}

/** Switch `current` to the previous version and remember the one it left, so a
 *  second rollback goes forward again. */
function rollback(paths: RuntimePaths, io: Io): number {
  const current = readCurrent(paths);
  const state = readState(paths);
  const previous = state.previous;
  if (!previous || previous === current) {
    io.err("browxai runtime: there is no previous version to roll back to. Nothing was changed.\n");
    return 1;
  }
  if (!existsSync(cliOf(versionDir(paths, previous)))) {
    io.err(
      `browxai runtime: ${cliOf(versionDir(paths, previous))} is missing. Nothing was changed.\n`,
    );
    return 1;
  }
  switchCurrent(paths, previous);
  writeState(paths, { ...state, ...(current ? { previous: current } : {}) });
  appendJournal(paths, {
    at: new Date().toISOString(),
    mode: "manual",
    event: "rollback",
    version: previous,
    ...(current ? { from: current } : {}),
  });
  io.out(`✓ current is ${previous}${current ? `, was ${current}` : ""}.\n`);
  if (current) {
    io.out(`  Servers already running keep ${current} until their MCP client starts them again.\n`);
  }
  return 0;
}

async function gc(paths: RuntimePaths, list: ProcessLister, io: Io): Promise<number> {
  const result = await collectGarbage(paths, readState(paths), { list });
  appendJournal(paths, {
    at: new Date().toISOString(),
    mode: "manual",
    event: "gc",
    result: result.removed.length ? `removed ${result.removed.join(", ")}` : "removed nothing",
  });
  io.out(renderGc(result));
  if (result.unknown) {
    io.err("browxai runtime: the process list could not be read, so no version was removed.\n");
    return 1;
  }
  return 0;
}

/** Remove the runtime directory, unless a running process uses one of its
 *  versions. Names the client configs that still point at the launcher. */
async function uninstall(
  paths: RuntimePaths,
  yes: boolean,
  flow: FlowDeps,
  io: Io,
): Promise<number> {
  const use = await versionsInUse(paths, flow.list);
  if (!yes && !use) {
    return refuse(
      io,
      "the process list could not be read, so it is unknown whether a server runs from this runtime. Pass --yes to remove it anyway.",
    );
  }
  if (!yes && use && use.size > 0) {
    const pids = [...use.values()].flat().join(", ");
    return refuse(
      io,
      `pid ${pids} runs from ${paths.root}. Stop those servers first, or pass --yes. Nothing was changed.`,
    );
  }
  if (flow.agent && flow.agent.installed().length > 0) {
    const removed = await flow.agent.remove();
    io.out(`✓ background job: ${removed.detail}\n`);
  }
  rmSync(paths.root, { recursive: true, force: true });
  io.out(`✓ removed ${paths.root}\n`);
  const still = leftoverConfigs(paths, flow.system);
  if (still.length) {
    io.out(
      `These client configs still name ${paths.shim}. Point their entries at another browxai:\n`,
    );
    for (const p of still) io.out(`  ${p}\n`);
  }
  return 0;
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

/** The real path of the `cli.js` this module belongs to. */
function selfCliPath(): string {
  const path = fileURLToPath(new URL("../cli.js", import.meta.url));
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
