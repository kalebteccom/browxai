import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./init.js";
import type { ClientSystem } from "./init-clients.js";

let dir: string;
let out = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browxai-init-"));
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const ARGS = ["--no-write", "--test-attrs", "data-testid"];

describe("browxai init", () => {
  it("keeps the node and dist/cli.js entry as the default snippet", async () => {
    expect(await runInit([dir, ...ARGS])).toBe(0);
    expect(out).toContain('"command": "node"');
    expect(out).toMatch(/"args": \[\s*"[^"]*cli\.js"\s*\]/);
  });

  it("prints the npx entry as the portable alternative", async () => {
    expect(await runInit([dir, ...ARGS])).toBe(0);
    expect(out).toContain('{ "command": "npx", "args": ["-y", "browxai"] }');
  });

  it("puts the workspace on the chrome commands so logins reach the MCP profile", async () => {
    expect(await runInit([dir, ...ARGS])).toBe(0);
    expect(out).toContain(`BROWX_WORKSPACE=${join(dir, ".browxai")} browxai chrome login`);
    expect(out).toContain(`BROWX_WORKSPACE=${join(dir, ".browxai")} browxai chrome start`);
  });

  it("prints the setup line for a client it finds", async () => {
    const home = mkdtempSync(join(tmpdir(), "browxai-home-"));
    mkdirSync(join(home, ".cursor"));
    const system: ClientSystem = {
      platform: "darwin",
      home,
      env: { PATH: "" },
      exists: existsSync,
    };
    try {
      expect(await runInit([dir, ...ARGS], { system })).toBe(0);
      expect(out).toContain("MCP clients found on this machine");
      expect(out).toContain(join(home, ".cursor", "mcp.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes no user-level file without --write-user-config", async () => {
    const home = mkdtempSync(join(tmpdir(), "browxai-home-"));
    mkdirSync(join(home, ".cursor"));
    const system: ClientSystem = {
      platform: "darwin",
      home,
      env: { PATH: "" },
      exists: existsSync,
    };
    try {
      await runInit([dir, "--test-attrs", "data-testid"], { system });
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
      expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("shows the diff, then writes the user-level file on --write-user-config", async () => {
    const home = mkdtempSync(join(tmpdir(), "browxai-home-"));
    const system: ClientSystem = {
      platform: "darwin",
      home,
      env: { PATH: "" },
      exists: existsSync,
    };
    try {
      const code = await runInit(
        [dir, "--test-attrs", "data-testid", "--write-user-config", "cursor"],
        {
          system,
        },
      );
      expect(code).toBe(0);
      const file = join(home, ".cursor", "mcp.json");
      expect(out).toContain(`Change to ${file}`);
      expect(out.indexOf("Change to")).toBeLessThan(out.indexOf("wrote " + file));
      expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.browxai.env.BROWX_WORKSPACE).toBe(
        join(dir, ".browxai"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("shows the diff and writes nothing under --no-write", async () => {
    const home = mkdtempSync(join(tmpdir(), "browxai-home-"));
    const system: ClientSystem = {
      platform: "darwin",
      home,
      env: { PATH: "" },
      exists: existsSync,
    };
    try {
      await runInit([dir, ...ARGS, "--write-user-config", "cursor"], { system });
      expect(out).toContain("not written (--no-write)");
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exits 1 when the client config cannot be edited", async () => {
    expect(await runInit([dir, ...ARGS, "--write-user-config", "claude-code"])).toBe(1);
    expect(out).toContain("claude mcp add-json");
  });

  it("prints usage for an unknown client or flag", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runInit([dir, "--write-user-config", "vim"])).toBe(2);
    expect(await runInit([dir, "--nope"])).toBe(2);
  });
});
