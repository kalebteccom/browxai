// `browxai init`: find the MCP clients on this machine and say how to wire browxai
// into each one. Detection and printing only. Nothing here writes a file; the
// user-level write lives in init-user-config.ts and runs only on an explicit flag.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type ClientId = "claude-code" | "cursor" | "codex" | "claude-desktop";

export const CLIENT_IDS: readonly ClientId[] = ["claude-code", "cursor", "codex", "claude-desktop"];

export const CLIENT_LABELS: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
};

/** The machine facts detection reads, so a test can supply its own. */
export interface ClientSystem {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
}

export function realSystem(): ClientSystem {
  return { platform: process.platform, home: homedir(), env: process.env, exists: existsSync };
}

/** One MCP server entry, in the shape every client config takes. */
export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The path as one shell word: bare when it is plain, single-quoted otherwise. */
export function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function onPath(sys: ClientSystem, command: string): boolean {
  const dirs = (sys.env.PATH ?? sys.env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = sys.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return dirs.some((d) => exts.some((x) => sys.exists(join(d, command + x))));
}

/** The user-level config file for a client, or undefined where it has none here. */
export function userConfigPath(id: ClientId, sys: ClientSystem): string | undefined {
  switch (id) {
    case "cursor":
      return join(sys.home, ".cursor", "mcp.json");
    case "codex":
      return join(sys.env.CODEX_HOME?.trim() || join(sys.home, ".codex"), "config.toml");
    case "claude-desktop":
      if (sys.platform === "darwin") {
        return join(
          sys.home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        );
      }
      if (sys.platform === "win32" && sys.env.APPDATA) {
        return join(sys.env.APPDATA, "Claude", "claude_desktop_config.json");
      }
      return undefined;
    case "claude-code":
      return undefined;
  }
}

/** Which clients look installed. Presence only, nothing is read from their files. */
export function detectClients(sys: ClientSystem): ClientId[] {
  const found: ClientId[] = [];
  if (onPath(sys, "claude")) found.push("claude-code");
  const cursorDir = userConfigPath("cursor", sys);
  if (
    (cursorDir && sys.exists(dirname(cursorDir))) ||
    (sys.platform === "darwin" && sys.exists("/Applications/Cursor.app"))
  ) {
    found.push("cursor");
  }
  const codexCfg = userConfigPath("codex", sys);
  if (onPath(sys, "codex") || (codexCfg && sys.exists(dirname(codexCfg)))) found.push("codex");
  const desktopCfg = userConfigPath("claude-desktop", sys);
  if (
    (desktopCfg && sys.exists(dirname(desktopCfg))) ||
    (sys.platform === "darwin" && sys.exists("/Applications/Claude.app"))
  ) {
    found.push("claude-desktop");
  }
  return found;
}

export function jsonSnippet(entry: ServerEntry): string {
  return JSON.stringify({ mcpServers: { browxai: entry } }, null, 2);
}

/** The `[mcp_servers.browxai]` block for Codex's config.toml. */
export function codexToml(entry: ServerEntry): string {
  const envPairs = Object.entries(entry.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  return [
    "[mcp_servers.browxai]",
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    ...(envPairs.length ? [`env = { ${envPairs.join(", ")} }`] : []),
  ].join("\n");
}

/** What to print for one client: a one-line command where the client has one,
 *  else the snippet and the file it goes in. */
export function clientInstructions(id: ClientId, entry: ServerEntry, sys: ClientSystem): string {
  const label = CLIENT_LABELS[id];
  const path = userConfigPath(id, sys);
  switch (id) {
    case "claude-code": {
      const json = JSON.stringify({ type: "stdio", ...entry });
      return `${label}, for every project:\n  claude mcp add-json browxai ${shellWord(json)} --scope user`;
    }
    case "codex": {
      const envFlags = Object.entries(entry.env)
        .map(([k, v]) => `--env ${shellWord(`${k}=${v}`)}`)
        .join(" ");
      const cmd = [entry.command, ...entry.args].map(shellWord).join(" ");
      return `${label}:\n  codex mcp add browxai ${envFlags} -- ${cmd}`;
    }
    case "cursor":
    case "claude-desktop": {
      const body = jsonSnippet(entry)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      return `${label}, add this to ${path ?? "its config file"}:\n${body}`;
    }
  }
}

/** The whole "clients found" block, ready to print. */
export function clientsReport(
  found: readonly ClientId[],
  entry: ServerEntry,
  sys: ClientSystem,
): string {
  if (found.length === 0) {
    return (
      "No MCP client found on this machine. The .mcp.json above works with any client that reads one, " +
      "or add this server by hand: command `npx`, args `-y browxai`.\n"
    );
  }
  const blocks = found.map((id) => clientInstructions(id, entry, sys));
  const writable = found.filter((id) => userConfigPath(id, sys) !== undefined);
  const tail = writable.length
    ? `\nTo have browxai edit a user-level config for you, run again with --write-user-config <client> (${writable.join(", ")}). It shows the change first.\n`
    : "";
  return `MCP clients found on this machine:\n\n${blocks.join("\n\n")}\n${tail}`;
}
