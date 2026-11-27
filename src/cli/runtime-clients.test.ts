import { describe, expect, it } from "vitest";
import type { ClientSystem } from "./init-clients.js";
import type { UserConfigPlan } from "./init-user-config.js";
import {
  activeTargets,
  claudeCommands,
  launcherArgs,
  profileTargets,
  rewriteCodexToml,
  rewriteJson,
  writeClientConfigs,
} from "./runtime-clients.js";

const SHIM = "/home/u/.browxai-runtime/bin/browxai";
const OLD = "/home/u/.browxai-runtime/node_modules/browxai/dist/cli.js";

describe("launcherArgs", () => {
  it.each([
    ["/usr/local/bin/node", [OLD], []],
    ["node", [OLD, "bridge", "--socket", "/s"], ["bridge", "--socket", "/s"]],
    ["/usr/local/lib/node_modules/browxai/dist/cli.js", ["serve"], ["serve"]],
    ["npx", ["-y", "browxai"], []],
    ["npx", ["-y", "browxai@latest", "bridge"], ["bridge"]],
  ])("rewrites %s %j", (command, args, rest) => {
    expect(launcherArgs(command, args)).toEqual(rest);
  });

  it.each([
    ["node", ["/home/u/src/browxai/dist/cli.js"]],
    ["/Applications/Browxai.app/Contents/Resources/bin/browxai", ["bridge"]],
    [SHIM, []],
    ["npx", ["-y", "other-tool", "browxai"]],
    ["node", []],
  ])("leaves %s %j alone", (command, args) => {
    expect(launcherArgs(command, args)).toBeUndefined();
  });
});

describe("rewriteJson", () => {
  it("rewrites every matching entry and keeps env and other entries", () => {
    const before = JSON.stringify({
      other: 1,
      mcpServers: {
        browxai: { command: "/usr/bin/node", args: [OLD], env: { BROWX_WORKSPACE: "/w" } },
        "browxai-attached": {
          command: "npx",
          args: ["-y", "browxai"],
          env: { BROWX_ATTACH_CDP: "x" },
        },
        github: { command: "gh-mcp", args: [] },
      },
    });
    const r = rewriteJson(before, SHIM);
    expect(r).toMatchObject({ names: ["browxai", "browxai-attached"] });
    const doc = JSON.parse((r as { after: string }).after) as Record<string, any>;
    expect(doc.other).toBe(1);
    expect(doc.mcpServers.browxai).toEqual({
      command: SHIM,
      args: [],
      env: { BROWX_WORKSPACE: "/w" },
    });
    expect(doc.mcpServers["browxai-attached"]).toEqual({
      command: SHIM,
      args: [],
      env: { BROWX_ATTACH_CDP: "x" },
    });
    expect(doc.mcpServers.github).toEqual({ command: "gh-mcp", args: [] });
  });

  it("leaves a file with nothing to rewrite byte for byte", () => {
    const before = '{ "mcpServers": { "x": { "command": "y" } } }';
    expect(rewriteJson(before, SHIM)).toEqual({ after: before, names: [] });
    expect(rewriteJson("{ // c\n}", SHIM)).toEqual({ error: "it is not plain JSON" });
  });
});

describe("rewriteCodexToml", () => {
  it("rewrites command and args of a matching table and nothing else", () => {
    const before = [
      'model = "x"',
      "",
      "[mcp_servers.browxai]",
      `command = "/usr/bin/node"`,
      `args = ["${OLD}"]`,
      `env = { BROWX_WORKSPACE = "/w" }`,
      "",
      "[mcp_servers.dev]",
      `command = "node"`,
      `args = ["/home/u/src/browxai/dist/cli.js"]`,
      "",
    ].join("\n");
    const r = rewriteCodexToml(before, SHIM);
    expect(r).toMatchObject({ names: ["browxai"] });
    expect((r as { after: string }).after).toBe(
      before
        .replace(`command = "/usr/bin/node"`, `command = "${SHIM}"`)
        .replace(`args = ["${OLD}"]`, "args = []"),
    );
  });

  it("leaves a multi-line args array alone", () => {
    const before = `[mcp_servers.browxai]\ncommand = "node"\nargs = [\n  "${OLD}",\n]\n`;
    expect(rewriteCodexToml(before, SHIM)).toEqual({ after: before, names: [] });
  });
});

describe("claudeCommands", () => {
  it("prints a remove and add-json pair per entry, with CLAUDE_CONFIG_DIR for a profile", () => {
    const text = JSON.stringify({
      mcpServers: { browxai: { type: "stdio", command: "node", args: [OLD], env: {} } },
    });
    const cmds = claudeCommands(text, SHIM, "/home/u/profiles/work");
    expect(cmds).toEqual([
      "CLAUDE_CONFIG_DIR=/home/u/profiles/work claude mcp remove browxai --scope user && " +
        `CLAUDE_CONFIG_DIR=/home/u/profiles/work claude mcp add-json browxai '{"type":"stdio","command":"${SHIM}","args":[],"env":{}}' --scope user`,
    ]);
  });
});

describe("which files are read", () => {
  const sys = (env: NodeJS.ProcessEnv, files: string[]): ClientSystem => ({
    platform: "darwin",
    home: "/home/u",
    env,
    exists: (p) => files.includes(p),
  });

  it("reads only the active config of each client", () => {
    const files = [
      "/home/u/.cursor/mcp.json",
      "/home/u/.codex/config.toml",
      "/home/u/.claude.json",
      "/home/u/profiles/work/.claude.json",
      "/home/u/Library/Application Support/Claude/claude_desktop_config.json",
    ];
    expect(activeTargets(sys({}, files)).map((t) => [t.id, t.path])).toEqual([
      ["cursor", "/home/u/.cursor/mcp.json"],
      ["codex", "/home/u/.codex/config.toml"],
      ["claude-desktop", "/home/u/Library/Application Support/Claude/claude_desktop_config.json"],
      ["claude-code", "/home/u/.claude.json"],
    ]);
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME to the active file, and nothing else", () => {
    const files = [
      "/home/u/profiles/work/.claude.json",
      "/home/u/.claude.json",
      "/home/u/c/config.toml",
    ];
    const env = { CLAUDE_CONFIG_DIR: "/home/u/profiles/work", CODEX_HOME: "/home/u/c" };
    expect(activeTargets(sys(env, files)).map((t) => t.path)).toEqual([
      "/home/u/c/config.toml",
      "/home/u/profiles/work/.claude.json",
    ]);
  });

  it("reads a profile directory only when it is named", () => {
    const files = ["/home/u/profiles/work/.claude.json", "/home/u/profiles/work/config.toml"];
    expect(profileTargets("/home/u/profiles/work", (p) => files.includes(p))).toEqual([
      {
        id: "codex",
        path: "/home/u/profiles/work/config.toml",
        profileDir: "/home/u/profiles/work",
      },
      {
        id: "claude-code",
        path: "/home/u/profiles/work/.claude.json",
        profileDir: "/home/u/profiles/work",
      },
    ]);
  });
});

describe("writeClientConfigs", () => {
  it("writes through applyUserConfig, prints Claude Code commands, and never writes Claude Code's file", () => {
    const files: Record<string, string> = {
      "/c/mcp.json": JSON.stringify({
        mcpServers: { browxai: { command: "node", args: [OLD], env: {} } },
      }),
      "/c/.claude.json": JSON.stringify({
        mcpServers: { browxai: { command: "npx", args: ["-y", "browxai"] } },
      }),
    };
    const written: UserConfigPlan[] = [];
    let out = "";
    const ok = writeClientConfigs(
      [
        { id: "cursor", path: "/c/mcp.json" },
        { id: "claude-code", path: "/c/.claude.json" },
      ],
      SHIM,
      { read: (p) => files[p]!, apply: (plan) => void written.push(plan), out: (t) => (out += t) },
    );
    expect(ok).toBe(true);
    expect(written.map((p) => (p as { path: string }).path)).toEqual(["/c/mcp.json"]);
    expect(out).toContain("✓ wrote /c/mcp.json (browxai)");
    expect(out).toContain("claude mcp add-json browxai");
  });

  it("returns false when a write fails", () => {
    const ok = writeClientConfigs([{ id: "cursor", path: "/c/mcp.json" }], SHIM, {
      read: () => JSON.stringify({ mcpServers: { b: { command: "node", args: [OLD] } } }),
      apply: () => {
        throw Object.assign(new Error("no"), { code: "EACCES" });
      },
      out: () => undefined,
    });
    expect(ok).toBe(false);
  });
});
