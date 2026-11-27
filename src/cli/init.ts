// `browxai init <workspace>` — bootstrap a per-app workspace ().
//
// Creates `<workspace>/.browxai/` (the consumer-co-located `BROWX_WORKSPACE`),
// emits a workspace-scope `.mcp.json` snippet the user can drop into their MCP
// client, and (if the workspace has a sibling source tree) heuristically sniffs
// the most-used test attribute convention so the printed `BROWX_TEST_ATTRIBUTES`
// order is right out of the gate.
//
// Stdout is fine — CLI subcommand.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilitiesAssignment, capabilitiesWith } from "../util/capabilities.js";
import {
  CLIENT_IDS,
  clientInstructions,
  clientsReport,
  detectClients,
  realSystem,
  shellWord,
  userConfigPath,
  type ClientId,
  type ClientSystem,
  type ServerEntry,
} from "./init-clients.js";
import { runSmoke, smokeChannel, type SmokeOptions, type SmokeResult } from "./init-smoke.js";
import { appWrapperOf, runningAppBundle } from "./macos-app.js";
import { findInstalledChrome } from "./chrome-launch.js";
import { runtimeLauncherFor } from "./runtime-layout.js";
import {
  applyUserConfig,
  lineDiff,
  planUserConfig,
  type UserConfigPlan,
} from "./init-user-config.js";

interface InitOpts {
  workspace: string;
  testAttrs?: string;
  noWrite?: boolean;
  /** `--no-write-user-config`: leave every client's own config file alone. */
  noWriteUserConfig?: boolean;
  /** `--write-user-config <client>`: limit the user-level write to one client. */
  writeUserConfig?: ClientId;
  noSmoke?: boolean;
}

/** Seams a test can replace. */
export interface InitDeps {
  system?: ClientSystem;
  smoke?: (opts: SmokeOptions) => Promise<SmokeResult>;
  /** Where the installed Google Chrome is, for the smoke check's channel. */
  findChrome?: () => string | undefined;
  /** Reads a user-level config file; undefined when it does not exist. */
  readConfig?: (path: string) => string | undefined;
  /** Writes a planned user-level config file. */
  applyConfig?: typeof applyUserConfig;
  /** The Browxai app this process runs from, or undefined outside it. */
  appBundle?: () => string | undefined;
  /** Picks the test attributes when `--test-attrs` is absent. */
  sniffAttrs?: (workspace: string) => { attrs: string[]; note: string };
  /** The runtime launcher to name when init runs from a runtime, or undefined. */
  runtimeLauncher?: (distCli: string, env: NodeJS.ProcessEnv) => string | undefined;
}

/** Printed to stdout for `--help` (exit 0, from `cli.ts`) and to stderr when
 *  the arguments are wrong (exit 2). */
export const INIT_USAGE =
  "usage: browxai init <workspace> [--test-attrs a,b,...] [--no-write]\n" +
  "                                [--no-write-user-config] [--no-smoke]\n" +
  "  <workspace>               per-app dir that holds browxai state\n" +
  "                            (for example ~/site-docs/<app>)\n" +
  "  --test-attrs a,b,...      test attributes to try, in order, for\n" +
  "                            BROWX_TEST_ATTRIBUTES. Default: sniffed from the\n" +
  "                            source next to the workspace.\n" +
  "  --no-write                print the .mcp.json snippet and each client\n" +
  "                            change, and write nothing\n" +
  "  --no-write-user-config    leave the user-level config of Cursor, Codex and\n" +
  "                            Claude Desktop alone. By default init prints the\n" +
  "                            change to each one it finds, then writes it. An\n" +
  "                            existing file is merged and the old copy kept as\n" +
  "                            <config>.browxai-bak. A file init will not edit\n" +
  "                            (not plain JSON), or one that already has an\n" +
  "                            entry, exits 0. A read or write error exits 1,\n" +
  "                            after every client was tried.\n" +
  "  --write-user-config [<client>]\n" +
  "                            accepted for older scripts, and a no-op: writing\n" +
  "                            is already the default. With a client it limits\n" +
  "                            the write to that client, one of:\n" +
  `                            ${CLIENT_IDS.join(", ")}\n` +
  "  --no-smoke                skip the headless first-snapshot check at the end\n" +
  "                            (also skipped under --no-write)\n";

export async function runInit(args: string[], deps: InitDeps = {}): Promise<number> {
  const opts = parseArgs(args);
  if (!opts) {
    process.stderr.write(INIT_USAGE);
    return 2;
  }
  const workspace = resolve(opts.workspace);
  const browxDir = join(workspace, ".browxai");

  // Sniff test attrs (if not explicit).
  let testAttrs = opts.testAttrs;
  let sniffNote = "";
  if (!testAttrs) {
    const sniffed = (deps.sniffAttrs ?? sniffTestAttributes)(workspace);
    testAttrs = sniffed.attrs.join(",");
    sniffNote = sniffed.note;
  }

  // Resolve the browxai dist/cli.js path (this script's repo).
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distCli = resolve(__dirname, "../cli.js");
  // Run from a runtime, every entry names its launcher, which follows updates.
  // The path of this version's cli.js would pin the entry to it.
  const launcher = (deps.runtimeLauncher ?? runtimeLauncherFor)(distCli, process.env);
  const server = launcher ? { command: launcher, args: [] } : { command: "node", args: [distCli] };

  const mcpJson = {
    mcpServers: {
      browxai: {
        ...server,
        env: {
          BROWX_WORKSPACE: browxDir,
          BROWX_TEST_ATTRIBUTES: testAttrs,
        },
      },
      "browxai-attached": {
        ...server,
        env: {
          BROWX_WORKSPACE: browxDir,
          BROWX_ATTACH_CDP: "http://127.0.0.1:9222",
          // Attaching needs `byob-attach`. The list replaces the default set,
          // so the four defaults stay in it.
          BROWX_CAPABILITIES: capabilitiesWith("byob-attach"),
          BROWX_TEST_ATTRIBUTES: testAttrs,
        },
      },
    },
  };
  const mcpJsonText = JSON.stringify(mcpJson, null, 2);

  process.stdout.write(`browxai init: setting up the workspace at ${workspace}\n\n`);

  if (!opts.noWrite) {
    if (!existsSync(browxDir)) {
      mkdirSync(browxDir, { recursive: true });
      process.stdout.write(`  ✓ created ${browxDir}\n`);
    } else {
      process.stdout.write(`  ✓ ${browxDir} already exists\n`);
    }
    const mcpPath = join(workspace, ".mcp.json");
    if (existsSync(mcpPath)) {
      process.stdout.write(
        `  ⚠  ${mcpPath} already exists, so it was left alone. Merge the snippet below into it by hand.\n`,
      );
    } else {
      writeFileSync(mcpPath, mcpJsonText + "\n", "utf8");
      process.stdout.write(`  ✓ wrote ${mcpPath} (workspace-scope MCP config)\n`);
    }
  }

  process.stdout.write(`\ntest-attributes order: ${testAttrs}\n`);
  if (sniffNote) process.stdout.write(`  ${sniffNote}\n`);
  process.stdout.write(
    `\n.mcp.json snippet (workspace-scope; pair with \`claude mcp add-json -s user\` for user-scope):\n\n${mcpJsonText}\n\n`,
  );
  if (launcher) {
    process.stdout.write(
      `browxai runs from a runtime, so the entries name its launcher ${launcher}. They start the version \`current\` names, and follow \`browxai runtime update\` with no edit.\n\n`,
    );
  } else {
    process.stdout.write(
      'Portable alternative to the absolute path above, which breaks when node or the global prefix moves: { "command": "npx", "args": ["-y", "browxai"] }\n\n',
    );
  }
  if (!launcher && /[\\/]_npx[\\/]/.test(distCli)) {
    process.stdout.write(
      `⚠  the snippet points at ${distCli}, inside the npx cache, which npm can delete. ` +
        "Run `npm install -g browxai` and run `browxai init` again so the path stays put.\n\n",
    );
  }
  const ws = shellWord(browxDir);
  // Run from the Browxai app, the user-level entries name the bridge, so those
  // clients share the app's daemon. Only where init runs from decides: an npm
  // install never looks for an installed app.
  const app = (deps.appBundle ?? runningAppBundle)();
  if (app !== undefined) process.stdout.write(WORKSPACE_FILE_NOTE);
  // The entry a user-level client config gets. Same server as the project file,
  // minus the attach entry, and never a path inside the npx cache. The command is
  // the absolute path of this node: a client started from the desktop (Claude
  // Desktop under launchd) does not get the shell's PATH, so a bare `node` fails.
  const inNpxCache = /[\\/]_npx[\\/]/.test(distCli);
  const userEntry: ServerEntry =
    app !== undefined
      ? bridgeEntry(app)
      : {
          ...(launcher
            ? server
            : inNpxCache
              ? { command: "npx", args: ["-y", "browxai"] }
              : { command: process.execPath, args: [distCli] }),
          env: { BROWX_WORKSPACE: browxDir, BROWX_TEST_ATTRIBUTES: testAttrs },
        };
  if (app !== undefined) process.stdout.write(BRIDGE_ENTRY_NOTE);
  const system = deps.system ?? realSystem();
  const found = detectClients(system);
  const reportMode =
    opts.writeUserConfig || opts.noWrite ? "none" : opts.noWriteUserConfig ? "skipped" : "auto";
  process.stdout.write(clientsReport(found, userEntry, system, reportMode) + "\n");
  const userConfigOk = userConfigSweep(opts, userEntry, system, deps);
  process.stdout.write(
    `next steps:\n  1) open Claude Code with cwd=${workspace} so this .mcp.json is picked up\n` +
      `  2) use the \`browxai\` MCP server for managed mode. It launches your installed Google Chrome. Without Chrome, add BROWX_CHANNEL=chromium to its env to use the bundled Chromium\n` +
      `  3) to sign in by hand once, run \`BROWX_WORKSPACE=${ws} browxai chrome login\`. The \`browxai\` entry reuses that login\n` +
      `  4) to attach to a Chrome you start yourself (BYOB, bring your own browser), run \`BROWX_WORKSPACE=${ws} browxai chrome start\`, then use \`browxai-attached\`.\n` +
      `     That entry's env sets ${capabilitiesAssignment("byob-attach")}; without byob-attach every attach is refused.\n` +
      `  5) run \`browxai doctor\` if a session fails to open\n\n` +
      `Keep BROWX_WORKSPACE=${ws} on every \`browxai chrome\` command. The entries above use it, and a Chrome started without it uses ~/.browxai/profile, which is a different profile.\n`,
  );
  let smokeOk = true;
  if (!opts.noSmoke && !opts.noWrite) {
    process.stdout.write("\nchecking that a headless session can take a snapshot...\n");
    const { channel, note } = smokeChannel(process.env, deps.findChrome ?? findInstalledChrome);
    if (note) process.stdout.write(`  ${note}\n`);
    const smoke = await (deps.smoke ?? runSmoke)({ distCli, ...(channel ? { channel } : {}) });
    process.stdout.write(`  ${smoke.message}\n`);
    smokeOk = smoke.ok;
  }
  return userConfigOk && smokeOk ? 0 : 1;
}

/**
 * The user-level entry when init runs from the Browxai app: the app's `browxai`
 * wrapper by absolute path, because a client started from the desktop does not get
 * the shell's PATH, and the `bridge` subcommand. The wrapper supplies the socket, and
 * a bridge reads no other setting, so `env` is empty.
 */
export function bridgeEntry(app: string): ServerEntry {
  return { command: appWrapperOf(app), args: ["bridge"], env: {} };
}

const BRIDGE_ENTRY_NOTE =
  "browxai runs from the Browxai app, so the user-level entries below use `browxai bridge`: " +
  "they reach the app's daemon, and its workspace, capabilities and settings apply.\n\n";

const WORKSPACE_FILE_NOTE =
  "A project opened with the .mcp.json above runs its own browxai server with the settings in that file. " +
  "It does not use the app's daemon.\n\n";

/**
 * The user-level write. A named client (`--write-user-config <client>`) is the
 * old behaviour: any problem with it fails the run. Without one, every detected
 * client that has a config file is handled, and all of them are tried before the
 * run ends. A client browxai declines to edit (`refuse`, or a file that already
 * has a browxai entry) prints its by-hand steps and leaves the exit code alone.
 * A read or write error (EACCES, a failed rename) fails the run with exit 1.
 * `--no-write-user-config` skips the step.
 */
function userConfigSweep(
  opts: InitOpts,
  entry: ServerEntry,
  system: ClientSystem,
  deps: InitDeps,
): boolean {
  if (opts.noWriteUserConfig) return true;
  const dryRun = !!opts.noWrite;
  if (opts.writeUserConfig) {
    return writeUserConfigStep(opts.writeUserConfig, entry, system, dryRun, deps) === "ok";
  }
  let allOk = true;
  for (const id of detectClients(system)) {
    if (userConfigPath(id, system) === undefined) continue;
    if (writeUserConfigStep(id, entry, system, dryRun, deps) === "failed") allOk = false;
  }
  return allOk;
}

/** `ok` wrote or left the file as it is, `refused` declined to edit it, `failed` hit an I/O error. */
type StepResult = "ok" | "refused" | "failed";

/** Print the change to a client's user-level config, then write it unless dryRun. */
function writeUserConfigStep(
  id: ClientId,
  entry: ServerEntry,
  system: ClientSystem,
  dryRun: boolean,
  deps: InitDeps,
): StepResult {
  let plan: UserConfigPlan;
  try {
    plan = planUserConfig(id, entry, system, deps.readConfig);
  } catch (e) {
    const path = userConfigPath(id, system) ?? "the config file";
    const code = (e as NodeJS.ErrnoException).code;
    const why =
      code === "EISDIR"
        ? "it is a folder"
        : code === "EACCES" || code === "EPERM"
          ? "permission denied"
          : `read failed${code ? `, ${code}` : ""}`;
    process.stdout.write(
      `  ✗ ${path} can't be read (${why}): add the entry by hand with:\n${clientInstructions(id, entry, system)}\n\n`,
    );
    return "failed";
  }
  if (plan.kind === "refuse") {
    process.stdout.write(`  ✗ ${plan.message}\n\n`);
    return "refused";
  } else if (plan.kind === "present") {
    process.stdout.write(`  ✓ ${plan.path} already has a browxai entry, left as it is\n\n`);
  } else {
    process.stdout.write(
      `Change to ${plan.path}:\n\n${lineDiff(plan.before, plan.after, plan.path)}\n\n`,
    );
    if (dryRun) {
      process.stdout.write("  not written (--no-write)\n\n");
    } else {
      try {
        (deps.applyConfig ?? applyUserConfig)(plan, { sync: system.fsync });
      } catch (e) {
        process.stdout.write(
          `  ✗ could not write ${plan.path} (${(e as NodeJS.ErrnoException).code ?? "write failed"}): add the entry by hand with:\n${clientInstructions(id, entry, system)}\n\n`,
        );
        return "failed";
      }
      process.stdout.write(`  ✓ wrote ${plan.path}. Restart the client to pick it up.\n\n`);
    }
  }
  return "ok";
}

function parseArgs(args: string[]): InitOpts | null {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return null;
  const positional: string[] = [];
  let testAttrs: string | undefined;
  let noWrite = false;
  let noWriteUserConfig = false;
  let writeUserConfig: ClientId | undefined;
  let sawWriteUserConfig = false;
  let noSmoke = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--write-user-config") {
      sawWriteUserConfig = true;
      // A bare flag is the old opt-in with nothing to say: writing is the default.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) continue;
      if (!(CLIENT_IDS as readonly string[]).includes(next)) return null;
      writeUserConfig = next as ClientId;
      i++;
      continue;
    }
    if (a === "--no-write-user-config") {
      noWriteUserConfig = true;
      continue;
    }
    if (a === "--no-smoke") {
      noSmoke = true;
      continue;
    }
    if (a.startsWith("--") && a !== "--test-attrs" && a !== "--no-write") return null;
    if (a === "--test-attrs") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return null;
      testAttrs = value;
      continue;
    }
    if (a === "--no-write") {
      noWrite = true;
      continue;
    }
    positional.push(a);
  }
  // Asking for the write, bare or for one client, and for no write contradict each other.
  if (noWriteUserConfig && sawWriteUserConfig) return null;
  if (positional.length !== 1) return null;
  return {
    workspace: positional[0]!,
    testAttrs,
    noWrite,
    noWriteUserConfig,
    writeUserConfig,
    noSmoke,
  };
}

/**
 * Sniff a consumer codebase for which `data-*` attribute is dominant. Looks at
 * the workspace's parent dir (typical layout: `~/site-docs/<app>/` and
 * `~/Projects/<app>/`) for `src/` and counts occurrences of each conventional
 * test attribute in `.ts` / `.tsx` / `.js` / `.jsx` files. Returns the attrs in
 * descending frequency order (most-used first — `BROWX_TEST_ATTRIBUTES` is
 * first-match-wins so the dominant convention should lead).
 *
 * Best-effort and bounded: walks at most 200 source files.
 */
export function sniffTestAttributes(workspace: string): { attrs: string[]; note: string } {
  const KNOWN = ["data-testid", "data-type", "data-test", "data-cy", "data-qa", "data-test-id"];
  const counts = new Map<string, number>(KNOWN.map((a) => [a, 0]));
  const candidates = [
    workspace, // in case workspace itself is a code repo
    join(workspace, "../"), // parent: typical sibling layout
    join(workspace, "src"),
    join(workspace, "../src"),
  ].filter((d) => existsSync(d));
  if (candidates.length === 0) {
    return { attrs: KNOWN.slice(0, 5), note: "(no sibling code dir found; default order)" };
  }
  let scanned = 0;
  for (const root of candidates) {
    walk(root, 4, (file) => {
      if (scanned >= 200) return false;
      if (!/\.(t|j)sx?$/.test(file)) return true;
      scanned++;
      try {
        const text = readFileSync(file, "utf8");
        for (const a of KNOWN) {
          const re = new RegExp(`${a}=`, "g");
          const m = text.match(re);
          if (m) counts.set(a, (counts.get(a) ?? 0) + m.length);
        }
      } catch {
        /* unreadable file — skip */
      }
      return true;
    });
    if (scanned >= 200) break;
  }
  const totalHits = [...counts.values()].reduce((a, b) => a + b, 0);
  if (totalHits === 0) {
    return {
      attrs: KNOWN.slice(0, 5),
      note: "(scanned but found 0 conventional attrs; default order)",
    };
  }
  const sorted = [...counts.entries()]
    .sort(([a, av], [b, bv]) => bv - av || KNOWN.indexOf(a) - KNOWN.indexOf(b))
    .filter(([, v]) => v > 0)
    .map(([k]) => k);
  // Always keep `data-testid` as a fallback so consumers with mixed conventions don't lose it.
  if (!sorted.includes("data-testid")) sorted.push("data-testid");
  const summary = [...counts.entries()]
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
  return { attrs: sorted, note: `(sniffed ${scanned} source file(s); hits: ${summary})` };
}

/** Calls `visit` on each file under `dir`; stops the whole walk, ancestors
 *  included, once `visit` returns false. Returns false when it stopped. */
function walk(dir: string, maxDepth: number, visit: (file: string) => boolean): boolean {
  if (maxDepth < 0) return true;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return true;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === "dist" || e.startsWith(".")) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!walk(full, maxDepth - 1, visit)) return false;
    } else if (st.isFile()) {
      if (!visit(full)) return false;
    }
  }
  return true;
}
