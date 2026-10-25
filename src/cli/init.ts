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
  clientsReport,
  detectClients,
  realSystem,
  shellWord,
  type ClientId,
  type ClientSystem,
  type ServerEntry,
} from "./init-clients.js";
import { runSmoke, type SmokeOptions, type SmokeResult } from "./init-smoke.js";
import { applyUserConfig, lineDiff, planUserConfig } from "./init-user-config.js";

interface InitOpts {
  workspace: string;
  testAttrs?: string;
  noWrite?: boolean;
  writeUserConfig?: ClientId;
  noSmoke?: boolean;
}

/** Seams a test can replace. */
export interface InitDeps {
  system?: ClientSystem;
  smoke?: (opts: SmokeOptions) => Promise<SmokeResult>;
}

export async function runInit(args: string[], deps: InitDeps = {}): Promise<number> {
  const opts = parseArgs(args);
  if (!opts) {
    process.stderr.write(
      "usage: browxai init <workspace> [--test-attrs data-testid,data-type,...] [--no-write]\n" +
        "                          [--write-user-config <client>] [--no-smoke]\n" +
        "  <workspace>                 per-app dir to host browxai state (e.g. ~/site-docs/<app>)\n" +
        "  --no-write                  print the .mcp.json snippet without creating files\n" +
        "  --write-user-config <client>  print the change to that client's user-level config,\n" +
        "                              then write it. Add --no-write to only print it.\n" +
        `                              <client> is one of: ${CLIENT_IDS.join(", ")}\n` +
        "  --no-smoke                  skip the headless first-snapshot check at the end\n" +
        "                              (also skipped under --no-write)\n",
    );
    return 2;
  }
  const workspace = resolve(opts.workspace);
  const browxDir = join(workspace, ".browxai");

  // Sniff test attrs (if not explicit).
  let testAttrs = opts.testAttrs;
  let sniffNote = "";
  if (!testAttrs) {
    const sniffed = sniffTestAttributes(workspace);
    testAttrs = sniffed.attrs.join(",");
    sniffNote = sniffed.note;
  }

  // Resolve the browxai dist/cli.js path (this script's repo).
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distCli = resolve(__dirname, "../cli.js");

  const mcpJson = {
    mcpServers: {
      browxai: {
        command: "node",
        args: [distCli],
        env: {
          BROWX_WORKSPACE: browxDir,
          BROWX_TEST_ATTRIBUTES: testAttrs,
        },
      },
      "browxai-attached": {
        command: "node",
        args: [distCli],
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

  process.stdout.write(`browxai init — bootstrap workspace at ${workspace}\n\n`);

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
        `  ⚠  ${mcpPath} exists — printing snippet below; merge manually so no existing entries are clobbered\n`,
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
  process.stdout.write(
    'Portable alternative to the absolute path above, which breaks when node or the global prefix moves: { "command": "npx", "args": ["-y", "browxai"] }\n\n',
  );
  if (/[\\/]_npx[\\/]/.test(distCli)) {
    process.stdout.write(
      `⚠  the snippet points at ${distCli}, inside the npx cache, which npm can delete. ` +
        "Run `npm install -g browxai` and run `browxai init` again so the path stays put.\n\n",
    );
  }
  const ws = shellWord(browxDir);
  // The entry a user-level client config gets. Same server as the project file,
  // minus the attach entry, and never a path inside the npx cache. The command is
  // the absolute path of this node: a client started from the desktop (Claude
  // Desktop under launchd) does not get the shell's PATH, so a bare `node` fails.
  const inNpxCache = /[\\/]_npx[\\/]/.test(distCli);
  const userEntry: ServerEntry = {
    ...(inNpxCache
      ? { command: "npx", args: ["-y", "browxai"] }
      : { command: process.execPath, args: [distCli] }),
    env: { BROWX_WORKSPACE: browxDir, BROWX_TEST_ATTRIBUTES: testAttrs },
  };
  const system = deps.system ?? realSystem();
  process.stdout.write(clientsReport(detectClients(system), userEntry, system) + "\n");
  const userConfigOk = opts.writeUserConfig
    ? writeUserConfigStep(opts.writeUserConfig, userEntry, system, !!opts.noWrite)
    : true;
  process.stdout.write(
    `next steps:\n  1) open Claude Code with cwd=${workspace} so this .mcp.json is picked up\n` +
      `  2) use the \`browxai\` MCP server for managed mode. It needs no more setup: it launches your installed Chrome, or the bundled Chromium without one\n` +
      `  3) to sign in by hand once, run \`BROWX_WORKSPACE=${ws} browxai chrome login\`. The \`browxai\` entry reuses that login\n` +
      `  4) to attach to a Chrome you start yourself (BYOB, bring your own browser), run \`BROWX_WORKSPACE=${ws} browxai chrome start\`, then use \`browxai-attached\`.\n` +
      `     That entry's env sets ${capabilitiesAssignment("byob-attach")}; without byob-attach every attach is refused.\n` +
      `  5) run \`browxai doctor\` if a session fails to open\n\n` +
      `Keep BROWX_WORKSPACE=${ws} on every \`browxai chrome\` command. The entries above use it, and a Chrome started without it uses ~/.browxai/profile, which is a different profile.\n`,
  );
  let smokeOk = true;
  if (!opts.noSmoke && !opts.noWrite) {
    process.stdout.write("\nchecking that a headless session can take a snapshot...\n");
    const smoke = await (deps.smoke ?? runSmoke)({ distCli });
    process.stdout.write(`${smoke.message}\n`);
    smokeOk = smoke.ok;
  }
  return userConfigOk && smokeOk ? 0 : 1;
}

/** Print the change to a client's user-level config, then write it unless dryRun. */
function writeUserConfigStep(
  id: ClientId,
  entry: ServerEntry,
  system: ClientSystem,
  dryRun: boolean,
): boolean {
  const plan = planUserConfig(id, entry, system);
  if (plan.kind === "refuse") {
    process.stdout.write(`  ✗ ${plan.message}\n\n`);
    return false;
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
        applyUserConfig(plan);
      } catch (e) {
        process.stdout.write(
          `  ✗ could not write ${plan.path}: ${e instanceof Error ? e.message : String(e)}\n\n`,
        );
        return false;
      }
      process.stdout.write(`  ✓ wrote ${plan.path}. Restart the client to pick it up.\n\n`);
    }
  }
  return true;
}

function parseArgs(args: string[]): InitOpts | null {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return null;
  const positional: string[] = [];
  let testAttrs: string | undefined;
  let noWrite = false;
  let writeUserConfig: ClientId | undefined;
  let noSmoke = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--write-user-config") {
      const id = args[++i];
      if (!id || !(CLIENT_IDS as readonly string[]).includes(id)) return null;
      writeUserConfig = id as ClientId;
      continue;
    }
    if (a === "--no-smoke") {
      noSmoke = true;
      continue;
    }
    if (a.startsWith("--") && a !== "--test-attrs" && a !== "--no-write") return null;
    if (a === "--test-attrs") {
      testAttrs = args[++i];
      continue;
    }
    if (a === "--no-write") {
      noWrite = true;
      continue;
    }
    positional.push(a);
  }
  if (positional.length !== 1) return null;
  return { workspace: positional[0]!, testAttrs, noWrite, writeUserConfig, noSmoke };
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
function sniffTestAttributes(workspace: string): { attrs: string[]; note: string } {
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

function walk(dir: string, maxDepth: number, visit: (file: string) => boolean): void {
  if (maxDepth < 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
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
    if (st.isDirectory()) walk(full, maxDepth - 1, visit);
    else if (st.isFile()) {
      if (!visit(full)) return;
    }
  }
}
