// `browxai runtime install --write-client-config`: point existing MCP client
// entries at the runtime's launcher. An entry is rewritten when its command runs
// an installed browxai (`.../node_modules/browxai/dist/cli.js`) or `npx browxai`.
// Its env and any subcommand arguments stay. A source checkout's `dist/cli.js` is
// left alone.
//
// Only the active config of each client is read: the one that client reads in
// this environment. No other profile directory is searched. `--profile-dir DIR`
// adds one directory the user names. Claude Code's file is never written, since
// Claude Code rewrites it while it runs: its entries get printed `claude mcp`
// commands. Writes go through init's `applyUserConfig`, which keeps the old file
// as `<config>.browxai-bak`.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { userConfigPath, shellWord, type ClientId, type ClientSystem } from "./init-clients.js";
import { applyUserConfig, lineDiff } from "./init-user-config.js";

export interface ClientTarget {
  id: ClientId;
  path: string;
  /** Set for a `--profile-dir` target: the directory the user named. */
  profileDir?: string;
}

const INSTALLED_CLI = /(^|[\\/])node_modules[\\/]browxai[\\/]dist[\\/]cli\.js$/;

/** The arguments to keep when `command` + `args` run an installed browxai, or
 *  undefined when the entry runs something else. */
export function launcherArgs(command: string, args: readonly string[]): string[] | undefined {
  if (INSTALLED_CLI.test(command)) return [...args];
  const exe = basename(command).replace(/\.(exe|cmd)$/i, "");
  if (/^node(js)?$/.test(exe) && args.length > 0 && INSTALLED_CLI.test(args[0]!))
    return args.slice(1);
  if (exe === "npx") {
    const at = args.findIndex((a) => !a.startsWith("-"));
    if (at >= 0 && /^browxai(@[\w.-]+)?$/.test(args[at]!)) return args.slice(at + 1);
  }
  return undefined;
}

/** The active config file of each client that has one here. */
export function activeTargets(sys: ClientSystem): ClientTarget[] {
  const out: ClientTarget[] = [];
  for (const id of ["cursor", "codex", "claude-desktop"] as const) {
    const path = userConfigPath(id, sys);
    if (path && sys.exists(path)) out.push({ id, path });
  }
  const claudeDir = sys.env.CLAUDE_CONFIG_DIR?.trim();
  const claude = claudeDir ? join(claudeDir, ".claude.json") : join(sys.home, ".claude.json");
  if (sys.exists(claude)) out.push({ id: "claude-code", path: claude });
  return out;
}

/** The client config files directly inside a directory the user named. */
export function profileTargets(
  dir: string,
  exists: (p: string) => boolean = existsSync,
): ClientTarget[] {
  const files: Array<[string, ClientId]> = [
    ["mcp.json", "cursor"],
    ["config.toml", "codex"],
    ["claude_desktop_config.json", "claude-desktop"],
    [".claude.json", "claude-code"],
  ];
  return files
    .filter(([name]) => exists(join(dir, name)))
    .map(([name, id]) => ({ id, path: join(dir, name), profileDir: dir }));
}

export type Rewrite = { after: string; names: string[] } | { error: string };

type Entry = { command?: unknown; args?: unknown; [k: string]: unknown };

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((a) => typeof a === "string");
}

/** Rewrite the matching `mcpServers` entries of a JSON client config. */
export function rewriteJson(text: string, shim: string): Rewrite {
  let doc: { mcpServers?: unknown };
  try {
    doc = JSON.parse(text) as { mcpServers?: unknown };
  } catch {
    return { error: "it is not plain JSON" };
  }
  const servers = doc?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    return { after: text, names: [] };
  const names: string[] = [];
  for (const [name, entry] of Object.entries(servers as Record<string, Entry>)) {
    if (!entry || typeof entry.command !== "string") continue;
    const args = entry.args === undefined ? [] : entry.args;
    if (!stringArray(args)) continue;
    const rest = launcherArgs(entry.command, args);
    if (!rest) continue;
    entry.command = shim;
    entry.args = rest;
    names.push(name);
  }
  return names.length
    ? { after: JSON.stringify(doc, null, 2) + "\n", names }
    : { after: text, names };
}

/**
 * Rewrite the matching `[mcp_servers.<name>]` tables of a Codex config.toml. A
 * line scan, not a TOML parser: it reads `command = "..."` and a one-line
 * `args = [...]` of plain strings, and leaves any other shape to the user.
 */
export function rewriteCodexToml(text: string, shim: string): Rewrite {
  const lines = text.split("\n");
  const names: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = /^\s*\[\s*mcp_servers\s*\.\s*"?([\w-]+)"?\s*\]\s*$/.exec(lines[i]!);
    i++;
    if (!header) continue;
    const start = i;
    while (i < lines.length && !/^\s*\[/.test(lines[i]!)) i++;
    if (rewriteCodexTable(lines, start, i, shim)) names.push(header[1]!);
  }
  return { after: names.length ? lines.join("\n") : text, names };
}

function rewriteCodexTable(lines: string[], from: number, to: number, shim: string): boolean {
  let cmdAt = -1;
  let argsAt = -1;
  for (let j = from; j < to; j++) {
    if (/^\s*command\s*=/.test(lines[j]!)) cmdAt = j;
    if (/^\s*args\s*=/.test(lines[j]!)) argsAt = j;
  }
  if (cmdAt < 0) return false;
  const command = tomlValue(lines[cmdAt]!);
  const args = argsAt < 0 ? [] : tomlValue(lines[argsAt]!);
  if (typeof command !== "string" || !stringArray(args)) return false;
  const rest = launcherArgs(command, args);
  if (!rest) return false;
  lines[cmdAt] = `command = ${JSON.stringify(shim)}`;
  const argsLine = `args = [${rest.map((a) => JSON.stringify(a)).join(", ")}]`;
  if (argsAt >= 0) lines[argsAt] = argsLine;
  else lines.splice(cmdAt + 1, 0, argsLine);
  return true;
}

/** The value of a `key = value` line when it is a plain string or a one-line array of them. */
function tomlValue(line: string): unknown {
  const raw = line.slice(line.indexOf("=") + 1).trim();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** One printed `claude mcp` pair per matching entry of a Claude Code config. */
export function claudeCommands(
  text: string,
  shim: string,
  profileDir?: string,
): string[] | { error: string } {
  let doc: { mcpServers?: Record<string, Entry> };
  try {
    doc = JSON.parse(text) as { mcpServers?: Record<string, Entry> };
  } catch {
    return { error: "it is not plain JSON" };
  }
  const prefix = profileDir ? `CLAUDE_CONFIG_DIR=${shellWord(profileDir)} ` : "";
  const out: string[] = [];
  for (const [name, entry] of Object.entries(doc.mcpServers ?? {})) {
    if (!entry || typeof entry.command !== "string") continue;
    const args = entry.args ?? [];
    if (!stringArray(args)) continue;
    const rest = launcherArgs(entry.command, args);
    if (!rest) continue;
    const json = JSON.stringify({
      ...entry,
      type: entry.type ?? "stdio",
      command: shim,
      args: rest,
    });
    out.push(
      `${prefix}claude mcp remove ${shellWord(name)} --scope user && ` +
        `${prefix}claude mcp add-json ${shellWord(name)} ${shellWord(json)} --scope user`,
    );
  }
  return out;
}

export interface WriteDeps {
  read?: (path: string) => string;
  apply?: typeof applyUserConfig;
  out: (text: string) => void;
}

/** Rewrite every target. Returns false when any file could not be read or written. */
export function writeClientConfigs(
  targets: readonly ClientTarget[],
  shim: string,
  deps: WriteDeps,
): boolean {
  let ok = true;
  for (const t of targets) {
    let text: string;
    try {
      text = (deps.read ?? ((p) => readFileSync(p, "utf8")))(t.path);
    } catch (e) {
      deps.out(
        `  ✗ ${t.path} can't be read (${(e as NodeJS.ErrnoException).code ?? "read failed"})\n`,
      );
      ok = false;
      continue;
    }
    if (t.id === "claude-code") {
      reportClaude(t, claudeCommands(text, shim, t.profileDir), deps.out);
      continue;
    }
    ok = writeOne(t, text, shim, deps) && ok;
  }
  return ok;
}

function reportClaude(
  t: ClientTarget,
  cmds: string[] | { error: string },
  out: (s: string) => void,
): void {
  if (!Array.isArray(cmds))
    out(`  ✗ ${t.path}: ${cmds.error}. Edit its browxai entries by hand.\n`);
  else if (cmds.length === 0) out(`  ✓ ${t.path}: no entry names an installed browxai\n`);
  else {
    out(`  Claude Code keeps ${t.path} itself, so browxai doesn't edit it. Run:\n`);
    for (const c of cmds) out(`    ${c}\n`);
  }
}

function writeOne(t: ClientTarget, before: string, shim: string, deps: WriteDeps): boolean {
  const r = t.id === "codex" ? rewriteCodexToml(before, shim) : rewriteJson(before, shim);
  if ("error" in r) {
    deps.out(`  ✗ ${t.path}: ${r.error}. Edit its browxai entries by hand.\n`);
    return true;
  }
  if (r.names.length === 0) {
    deps.out(`  ✓ ${t.path}: no entry names an installed browxai\n`);
    return true;
  }
  deps.out(`Change to ${t.path}:\n\n${lineDiff(before, r.after, t.path)}\n\n`);
  try {
    (deps.apply ?? applyUserConfig)({ kind: "add", path: t.path, before, after: r.after });
  } catch (e) {
    deps.out(
      `  ✗ could not write ${t.path} (${(e as NodeJS.ErrnoException).code ?? "write failed"})\n`,
    );
    return false;
  }
  deps.out(`  ✓ wrote ${t.path} (${r.names.join(", ")}). Restart the client to pick it up.\n`);
  return true;
}
