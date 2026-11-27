// `browxai runtime <verb>`: manage a runtime directory that keeps browxai
// releases side by side under one launcher path. See
// docs/rfcs/0015-runtime-updates.md. Exit codes follow the shell route: 0 ok,
// 1 a failed check or an internal error, 2 usage or a refused context.

import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runningAppBundle } from "./macos-app.js";
import { runProgram, type Runner } from "./runtime-exec.js";
import {
  collectGarbage,
  systemProcessLister,
  type GcResult,
  type ProcessLister,
} from "./runtime-gc.js";
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
import { renderStatus, runtimeStatus } from "./runtime-status.js";
import { readCurrent, readState, switchCurrent, writeState } from "./runtime-store.js";

export const RUNTIME_USAGE =
  "usage: browxai runtime <status|rollback|gc> [flags]\n" +
  "  status [--json]   the runtime directory, the version `current` names, the kept\n" +
  "                    versions and the processes that use them. No network.\n" +
  "  rollback          switch `current` back to the previous version. No network.\n" +
  "  gc                keep three versions (current, previous and one more) and\n" +
  "                    remove older ones that no running process uses\n" +
  "The runtime directory is $BROWX_RUNTIME_DIR, or ~/.browxai-runtime.\n" +
  "Exit 0 ok, 1 a failed check or an internal error, 2 usage or a refused context.\n";

/** Seams a test can replace. */
export interface RuntimeDeps {
  ctx?: RuntimeContext;
  run?: Runner;
  list?: ProcessLister;
  /** The Browxai app this process runs from, or undefined outside it. */
  appBundle?: () => string | undefined;
  /** The real path of the `cli.js` this process runs. */
  selfCli?: string;
  now?: () => number;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const APP_MESSAGE =
  "browxai runtime: this browxai is the signed Browxai app, which updates through Homebrew: brew upgrade --cask browxai\n";

type Verb = "status" | "rollback" | "gc";

function parseRuntimeArgs(args: readonly string[]): { verb: Verb; json: boolean } | undefined {
  const [verb, ...rest] = args;
  if (verb === "status") {
    if (rest.length === 0) return { verb, json: false };
    if (rest.length === 1 && rest[0] === "--json") return { verb, json: true };
    return undefined;
  }
  if ((verb === "rollback" || verb === "gc") && rest.length === 0) return { verb, json: false };
  return undefined;
}

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
  const dir = resolveRuntimeDir(ctx);
  if ("error" in dir) {
    io.err(`browxai runtime: ${dir.error}\n`);
    return 2;
  }
  const checked = inspectRuntime(dir.dir, ctx, parsed.verb !== "status");
  if (!checked.ok) {
    io.err(`browxai runtime: ${checked.reason}${checked.reason.endsWith("\n") ? "" : "\n"}`);
    return 2;
  }
  const paths = runtimePaths(dir.dir);
  const list = deps.list ?? systemProcessLister(deps.run ?? runProgram, ctx.platform);
  if (parsed.verb === "status") {
    const status = await runtimeStatus(paths, checked.found, {
      env: ctx.env,
      list,
      selfCli: deps.selfCli ?? selfCliPath(),
    });
    io.out(parsed.json ? JSON.stringify(status, null, 2) + "\n" : renderStatus(status));
    return 0;
  }
  if (checked.found.kind !== "managed") {
    io.err(`browxai runtime: no browxai runtime at ${dir.dir}. Run: browxai runtime install\n`);
    return 2;
  }
  if (parsed.verb === "rollback") return rollback(paths, io);
  return gc(paths, { list, now: deps.now }, io);
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
  io.out(`✓ current is ${previous}${current ? `, was ${current}` : ""}.\n`);
  if (current) {
    io.out(`  Servers already running keep ${current} until their MCP client starts them again.\n`);
  }
  return 0;
}

async function gc(
  paths: RuntimePaths,
  deps: { list: ProcessLister; now?: () => number },
  io: Io,
): Promise<number> {
  const result = await collectGarbage(paths, readState(paths), {
    list: deps.list,
    ...(deps.now ? { now: deps.now } : {}),
  });
  io.out(renderGc(result));
  if (result.unknown) {
    io.err("browxai runtime: the process list could not be read, so no version was removed.\n");
    return 1;
  }
  return 0;
}

export function renderGc(r: GcResult): string {
  const lines = [`kept: ${r.kept.join(", ") || "none"}`];
  if (r.removed.length) lines.push(`removed: ${r.removed.join(", ")}`);
  for (const u of r.inUse) lines.push(`kept ${u.version}: in use by pid ${u.pids.join(", ")}`);
  if (r.stagingRemoved.length) lines.push(`removed from staging: ${r.stagingRemoved.join(", ")}`);
  return lines.join("\n") + "\n";
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
