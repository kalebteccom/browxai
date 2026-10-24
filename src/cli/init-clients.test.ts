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
});

describe("clientsReport", () => {
  it("says so when no client is found", () => {
    expect(clientsReport([], ENTRY, fakeSystem())).toContain("No MCP client found");
  });

  it("offers --write-user-config only for clients with a config file", () => {
    const out = clientsReport(["claude-code", "cursor"], ENTRY, fakeSystem());
    expect(out).toContain("--write-user-config <client> (cursor)");
  });
});

describe("helpers", () => {
  it("quotes only when needed", () => {
    expect(shellWord("/a/b")).toBe("/a/b");
    expect(shellWord("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });

  it("writes a Codex table with an inline env", () => {
    const toml = codexToml(ENTRY);
    expect(toml).toContain("[mcp_servers.browxai]");
    expect(toml).toContain('args = ["/opt/browxai/dist/cli.js"]');
    expect(toml).toContain('env = { BROWX_WORKSPACE = "/work/app/.browxai"');
  });
});
