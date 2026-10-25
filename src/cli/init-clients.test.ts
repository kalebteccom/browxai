import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clientInstructions,
  clientsReport,
  codexToml,
  detectClients,
  shellWord,
  userConfigPath,
  type ClientSystem,
  type ServerEntry,
} from "./init-clients.js";

function fakeSystem(over: Partial<ClientSystem> & { present?: string[] } = {}): ClientSystem {
  const present = new Set(over.present ?? []);
  return {
    platform: over.platform ?? "darwin",
    home: over.home ?? "/home/u",
    env: over.env ?? { PATH: "/usr/local/bin:/usr/bin" },
    exists: (p) => present.has(p),
  };
}

const ENTRY: ServerEntry = {
  command: "node",
  args: ["/opt/browxai/dist/cli.js"],
  env: { BROWX_WORKSPACE: "/work/app/.browxai", BROWX_TEST_ATTRIBUTES: "data-testid" },
};

describe("detectClients", () => {
  it("finds nothing on an empty machine", () => {
    expect(detectClients(fakeSystem())).toEqual([]);
  });

  it("finds Claude Code and Codex on PATH", () => {
    const sys = fakeSystem({ present: ["/usr/local/bin/claude", "/usr/bin/codex"] });
    expect(detectClients(sys)).toEqual(["claude-code", "codex"]);
  });

  it("finds Cursor and Codex by their config directories", () => {
    const sys = fakeSystem({ present: ["/home/u/.cursor", "/home/u/.codex"] });
    expect(detectClients(sys)).toEqual(["cursor", "codex"]);
  });

  it("honours CODEX_HOME", () => {
    const sys = fakeSystem({
      env: { PATH: "", CODEX_HOME: "/data/codex" },
      present: ["/data/codex"],
    });
    expect(detectClients(sys)).toEqual(["codex"]);
    expect(userConfigPath("codex", sys)).toBe("/data/codex/config.toml");
  });

  it("finds Claude Desktop by its macOS config directory", () => {
    const sys = fakeSystem({ present: ["/home/u/Library/Application Support/Claude"] });
    expect(detectClients(sys)).toEqual(["claude-desktop"]);
  });

  it("finds Claude Desktop under APPDATA on Windows", () => {
    const sys = fakeSystem({
      platform: "win32",
      env: { PATH: "", APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      present: [],
    });
    expect(userConfigPath("claude-desktop", sys)).toContain("claude_desktop_config.json");
  });

  it("has no Claude Desktop config path on Linux", () => {
    expect(userConfigPath("claude-desktop", fakeSystem({ platform: "linux" }))).toBeUndefined();
  });

  it("finds all four clients, in a fixed order", () => {
    const sys = fakeSystem({
      present: [
        "/usr/bin/claude",
        "/home/u/.cursor",
        "/home/u/.codex",
        "/home/u/Library/Application Support/Claude",
      ],
    });
    expect(detectClients(sys)).toEqual(["claude-code", "cursor", "codex", "claude-desktop"]);
  });

  it("finds Cursor and Claude Desktop by their macOS apps", () => {
    const sys = fakeSystem({ present: ["/Applications/Cursor.app", "/Applications/Claude.app"] });
    expect(detectClients(sys)).toEqual(["cursor", "claude-desktop"]);
  });

  it("ignores the macOS apps on Linux", () => {
    const sys = fakeSystem({
      platform: "linux",
      present: ["/Applications/Cursor.app", "/Applications/Claude.app"],
    });
    expect(detectClients(sys)).toEqual([]);
  });

  it("finds Claude Desktop by its directory under APPDATA on Windows", () => {
    const sys = fakeSystem({
      platform: "win32",
      env: { PATH: "", APPDATA: "/AppData" },
      present: ["/AppData/Claude"],
    });
    expect(detectClients(sys)).toEqual(["claude-desktop"]);
    expect(userConfigPath("claude-desktop", sys)).toBe(
      join("/AppData", "Claude", "claude_desktop_config.json"),
    );
  });

  it("has no Claude Desktop config path on Windows without APPDATA", () => {
    const sys = fakeSystem({ platform: "win32", env: { PATH: "" } });
    expect(userConfigPath("claude-desktop", sys)).toBeUndefined();
  });

  it("finds a Windows command by its .exe, .cmd or .bat name", () => {
    for (const file of ["claude.exe", "claude.cmd", "claude.bat"]) {
      const sys = fakeSystem({
        platform: "win32",
        env: { PATH: "/bin" },
        present: [join("/bin", file)],
      });
      expect(detectClients(sys)).toEqual(["claude-code"]);
    }
  });

  it("does not try Windows extensions elsewhere", () => {
    const sys = fakeSystem({ env: { PATH: "/bin" }, present: [join("/bin", "claude.exe")] });
    expect(detectClients(sys)).toEqual([]);
  });

  it("reads a PATH spelled Path, and survives no PATH at all", () => {
    expect(
      detectClients(fakeSystem({ env: { Path: "/opt/bin" }, present: ["/opt/bin/claude"] })),
    ).toEqual(["claude-code"]);
    expect(detectClients(fakeSystem({ env: {} }))).toEqual([]);
  });

  it("uses ~/.codex when CODEX_HOME is blank", () => {
    const sys = fakeSystem({
      env: { PATH: "", CODEX_HOME: "  " },
      present: ["/home/u/.codex"],
    });
    expect(userConfigPath("codex", sys)).toBe("/home/u/.codex/config.toml");
    expect(detectClients(sys)).toEqual(["codex"]);
  });

  it("has no Codex config path for a relative CODEX_HOME, and finds Codex on PATH only", () => {
    const env = { PATH: "/usr/bin", CODEX_HOME: "rel" };
    const dirOnly = fakeSystem({ env, present: ["/home/u/.codex", "rel"] });
    expect(userConfigPath("codex", dirOnly)).toBeUndefined();
    expect(detectClients(dirOnly)).toEqual([]);
    expect(detectClients(fakeSystem({ env, present: ["/usr/bin/codex"] }))).toEqual(["codex"]);
  });

  it("has no user config path for Claude Code", () => {
    expect(userConfigPath("claude-code", fakeSystem())).toBeUndefined();
  });
});

describe("clientInstructions", () => {
  it("gives Claude Code one add-json line at user scope", () => {
    const out = clientInstructions("claude-code", ENTRY, fakeSystem());
    expect(out).toContain("claude mcp add-json browxai '");
    expect(out).toContain("--scope user");
    expect(out).toContain('"command":"node"');
  });

  it("gives Codex one add line with one --env per variable", () => {
    const out = clientInstructions("codex", ENTRY, fakeSystem());
    expect(out).toContain("codex mcp add browxai --env BROWX_WORKSPACE=/work/app/.browxai");
    expect(out).toContain("--env BROWX_TEST_ATTRIBUTES=data-testid");
    expect(out).toContain("-- node /opt/browxai/dist/cli.js");
  });

  it("names the config file for Cursor and Claude Desktop", () => {
    const sys = fakeSystem();
    expect(clientInstructions("cursor", ENTRY, sys)).toContain("/home/u/.cursor/mcp.json");
    expect(clientInstructions("claude-desktop", ENTRY, sys)).toContain(
      "Application Support/Claude/claude_desktop_config.json",
    );
    expect(clientInstructions("cursor", ENTRY, sys)).toContain('"mcpServers"');
  });

  it("says its config file when Claude Desktop has no known path", () => {
    const out = clientInstructions("claude-desktop", ENTRY, fakeSystem({ platform: "linux" }));
    expect(out).toContain("add this to its config file:");
  });

  it("puts the stdio type into the Claude Code JSON", () => {
    const out = clientInstructions("claude-code", ENTRY, fakeSystem());
    expect(out).toContain('"type":"stdio","command":"node"');
  });

  it("escapes an apostrophe in a Claude Code argument", () => {
    const entry = { ...ENTRY, args: ["/opt/it's/cli.js"] };
    expect(clientInstructions("claude-code", entry, fakeSystem())).toContain("it'\\''s");
  });

  it("quotes a Codex env value that has a space", () => {
    const entry = { ...ENTRY, env: { BROWX_WORKSPACE: "/work/my app/.browxai" } };
    const out = clientInstructions("codex", entry, fakeSystem());
    expect(out).toContain("--env 'BROWX_WORKSPACE=/work/my app/.browxai' -- node");
  });
});

describe("clientsReport", () => {
  it("says so when no client is found", () => {
    expect(clientsReport([], ENTRY, fakeSystem())).toContain("No MCP client found");
  });

  it("offers --write-user-config only for clients with a config file", () => {
    const out = clientsReport(["claude-code", "cursor"], ENTRY, fakeSystem());
    expect(out).toContain("--write-user-config <client> (cursor)");
  });

  it("lists every writable client when all four are found", () => {
    const out = clientsReport(
      ["claude-code", "cursor", "codex", "claude-desktop"],
      ENTRY,
      fakeSystem(),
    );
    expect(out.startsWith("MCP clients found on this machine:\n\n")).toBe(true);
    for (const label of ["Claude Code", "Cursor", "Codex", "Claude Desktop"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("--write-user-config <client> (cursor, codex, claude-desktop)");
    expect(out).toContain("Add --no-write to only print it.");
  });

  it("offers nothing to write when only Claude Code is found", () => {
    const out = clientsReport(["claude-code"], ENTRY, fakeSystem());
    expect(out).toContain("claude mcp add-json");
    expect(out).not.toContain("--write-user-config");
  });

  it("does not offer Codex under a relative CODEX_HOME", () => {
    const sys = fakeSystem({ env: { PATH: "", CODEX_HOME: "rel" } });
    expect(clientsReport(["codex"], ENTRY, sys)).not.toContain("--write-user-config");
  });

  it("does not offer Claude Desktop on Linux", () => {
    const sys = fakeSystem({ platform: "linux" });
    const out = clientsReport(["claude-desktop", "cursor"], ENTRY, sys);
    expect(out).toContain("--write-user-config <client> (cursor)");
  });

  it("names the npx fallback when no client is found", () => {
    expect(clientsReport([], ENTRY, fakeSystem())).toContain("command `npx`, args `-y browxai`");
  });
});

describe("helpers", () => {
  it("quotes only when needed", () => {
    expect(shellWord("/a/b")).toBe("/a/b");
    expect(shellWord("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });

  it("quotes an empty string and leaves KEY=value:list words bare", () => {
    expect(shellWord("")).toBe("''");
    expect(shellWord("A=b:c,d@e%f+g")).toBe("A=b:c,d@e%f+g");
  });

  it("omits the env line from a Codex table with no env", () => {
    expect(codexToml({ ...ENTRY, env: {} })).toBe(
      '[mcp_servers.browxai]\ncommand = "node"\nargs = ["/opt/browxai/dist/cli.js"]',
    );
  });

  it("escapes a backslash in a Codex env value", () => {
    expect(codexToml({ ...ENTRY, env: { P: "C:\\x" } })).toContain('env = { P = "C:\\\\x" }');
  });

  it("writes a Codex table with an inline env", () => {
    const toml = codexToml(ENTRY);
    expect(toml).toContain("[mcp_servers.browxai]");
    expect(toml).toContain('args = ["/opt/browxai/dist/cli.js"]');
    expect(toml).toContain('env = { BROWX_WORKSPACE = "/work/app/.browxai"');
  });
});
