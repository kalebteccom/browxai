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

interface InitOpts {
  workspace: string;
  testAttrs?: string;
  noWrite?: boolean;
}

export async function runInit(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (!opts) {
    process.stderr.write(
      "usage: browxai init <workspace> [--test-attrs data-testid,data-type,...] [--no-write]\n" +
        "  <workspace>  per-app dir to host browxai state (e.g. ~/site-docs/<app>)\n" +
        "  --no-write   print the .mcp.json snippet without creating files\n",
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
      process.stdout.write(`  ⚠  ${mcpPath} exists — printing snippet below; merge manually so no existing entries are clobbered\n`);
    } else {
      writeFileSync(mcpPath, mcpJsonText + "\n", "utf8");
      process.stdout.write(`  ✓ wrote ${mcpPath} (workspace-scope MCP config)\n`);
    }
  }

  process.stdout.write(`\ntest-attributes order: ${testAttrs}\n`);
  if (sniffNote) process.stdout.write(`  ${sniffNote}\n`);
  process.stdout.write(`\n.mcp.json snippet (workspace-scope; pair with \`claude mcp add-json -s user\` for user-scope):\n\n${mcpJsonText}\n\n`);
  process.stdout.write(
    `next steps:\n  1) open Claude Code with cwd=${workspace} so this .mcp.json is picked up\n` +
      `  2) (BYOB) \`browxai chrome start\` to launch the attachable Chrome\n` +
      `  3) use the \`browxai\` MCP server for managed mode, \`browxai-attached\` for BYOB\n`,
  );
  return 0;
}

function parseArgs(args: string[]): InitOpts | null {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return null;
  const positional: string[] = [];
  let testAttrs: string | undefined;
  let noWrite = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--test-attrs") { testAttrs = args[++i]; continue; }
    if (a === "--no-write") { noWrite = true; continue; }
    positional.push(a);
  }
  if (positional.length !== 1) return null;
  return { workspace: positional[0]!, testAttrs, noWrite };
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
      } catch { /* unreadable file — skip */ }
      return true;
    });
    if (scanned >= 200) break;
  }
  const totalHits = [...counts.values()].reduce((a, b) => a + b, 0);
  if (totalHits === 0) {
    return { attrs: KNOWN.slice(0, 5), note: "(scanned but found 0 conventional attrs; default order)" };
  }
  const sorted = [...counts.entries()]
    .sort(([a, av], [b, bv]) => bv - av || KNOWN.indexOf(a) - KNOWN.indexOf(b))
    .filter(([, v]) => v > 0)
    .map(([k]) => k);
  // Always keep `data-testid` as a fallback so consumers with mixed conventions don't lose it.
  if (!sorted.includes("data-testid")) sorted.push("data-testid");
  const summary = [...counts.entries()].filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`).join(", ");
  return { attrs: sorted, note: `(sniffed ${scanned} source file(s); hits: ${summary})` };
}

function walk(dir: string, maxDepth: number, visit: (file: string) => boolean): void {
  if (maxDepth < 0) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === "dist" || e.startsWith(".")) continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, maxDepth - 1, visit);
    else if (st.isFile()) { if (!visit(full)) return; }
  }
}
