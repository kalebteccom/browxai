import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  it("prints the node and dist/cli.js entry as the default snippet and the npx entry as the portable alternative", async () => {
    expect(await runInit([dir, ...ARGS])).toBe(0);
    expect(out).toContain('"command": "node"');
    expect(out).toMatch(/"args": \[\s*"[^"]*cli\.js"\s*\]/);
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

  it("writes no user-level file under --no-write-user-config", async () => {
    const home = mkdtempSync(join(tmpdir(), "browxai-home-"));
    mkdirSync(join(home, ".cursor"));
    const system: ClientSystem = {
      platform: "darwin",
      home,
      env: { PATH: "" },
      exists: existsSync,
    };
    try {
      const args = [dir, "--test-attrs", "data-testid", "--no-smoke", "--no-write-user-config"];
      expect(await runInit(args, { system })).toBe(0);
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
        [dir, "--test-attrs", "data-testid", "--no-smoke", "--write-user-config", "cursor"],
        {
          system,
        },
      );
      expect(code).toBe(0);
      const file = join(home, ".cursor", "mcp.json");
      expect(out).toContain(`Change to ${file}`);
      expect(out.indexOf("Change to")).toBeLessThan(out.indexOf("wrote " + file));
      const written = JSON.parse(readFileSync(file, "utf8")).mcpServers.browxai;
      expect(written.env.BROWX_WORKSPACE).toBe(join(dir, ".browxai"));
      // An absolute node path: a desktop client does not get the shell's PATH.
      expect(written.command).toBe(process.execPath);
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

  describe("smoke test", () => {
    const WRITE = ["--test-attrs", "data-testid", "--no-write-user-config"];

    it("prints the result line last and exits 0 when it passes", async () => {
      const smoke = vi
        .fn()
        .mockResolvedValue({ ok: true, message: "ok: first snapshot in 812 ms" });
      expect(await runInit([dir, ...WRITE], { smoke })).toBe(0);
      expect(smoke).toHaveBeenCalledOnce();
      expect(out.trimEnd().endsWith("ok: first snapshot in 812 ms")).toBe(true);
    });

    it("prints the error and exits 1 when it fails", async () => {
      const smoke = vi
        .fn()
        .mockResolvedValue({ ok: false, message: "error: no browser. Run `browxai doctor`." });
      expect(await runInit([dir, ...WRITE], { smoke })).toBe(1);
      expect(out).toContain("error: no browser");
    });

    it("does not run under --no-smoke", async () => {
      const smoke = vi.fn();
      expect(await runInit([dir, ...WRITE, "--no-smoke"], { smoke })).toBe(0);
      expect(smoke).not.toHaveBeenCalled();
    });

    it("does not run under --no-write", async () => {
      const smoke = vi.fn();
      expect(await runInit([dir, ...ARGS], { smoke })).toBe(0);
      expect(smoke).not.toHaveBeenCalled();
    });
  });
});

function homeSystem(home: string, over: Partial<ClientSystem> = {}): ClientSystem {
  return { platform: "darwin", home, env: { PATH: "" }, exists: existsSync, ...over };
}

describe("browxai init --write-user-config", () => {
  const BASE = ["--test-attrs", "data-testid", "--no-smoke"];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "browxai-home-"));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("leaves a config that already has a browxai entry as it is", async () => {
    const file = join(home, ".cursor", "mcp.json");
    const original = JSON.stringify({ mcpServers: { browxai: { command: "mine" } } });
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file, original);
    const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
      system: homeSystem(home),
    });
    expect(code).toBe(0);
    expect(out).toContain(`${file} already has a browxai entry, left as it is`);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("exits 1 and leaves a file that is not plain JSON untouched", async () => {
    const file = join(home, ".cursor", "mcp.json");
    const original = '{ // mine\n  "mcpServers": {}\n}\n';
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file, original);
    const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
      system: homeSystem(home),
    });
    expect(code).toBe(1);
    expect(out).toContain("is not plain JSON");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("exits 1 for a JSON array and leaves the file alone", async () => {
    const file = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file, "[]\n");
    const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
      system: homeSystem(home),
    });
    expect(code).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("[]\n");
  });

  it("fills an empty config file", async () => {
    const file = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file, "");
    const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
      system: homeSystem(home),
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.browxai.command).toBe(
      process.execPath,
    );
  });

  it("writes Codex's config.toml under CODEX_HOME", async () => {
    const codexHome = join(home, "codex-home");
    const system = homeSystem(home, { env: { PATH: "", CODEX_HOME: codexHome } });
    const code = await runInit([dir, ...BASE, "--write-user-config", "codex"], { system });
    expect(code).toBe(0);
    const file = join(codexHome, "config.toml");
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("[mcp_servers.browxai]\n")).toBe(true);
    expect(text).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(out).toContain("--- (new file)");
    expect(out).toContain("+ [mcp_servers.browxai]");
  });

  it("writes Claude Desktop's config under Application Support on macOS", async () => {
    const code = await runInit([dir, ...BASE, "--write-user-config", "claude-desktop"], {
      system: homeSystem(home),
    });
    expect(code).toBe(0);
    const file = join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.browxai.env.BROWX_WORKSPACE).toBe(
      join(dir, ".browxai"),
    );
  });

  it("exits 1 for a relative CODEX_HOME and writes nothing", async () => {
    const system = homeSystem(home, { env: { PATH: "", CODEX_HOME: "codex-home" } });
    const code = await runInit([dir, ...BASE, "--write-user-config", "codex"], { system });
    expect(code).toBe(1);
    expect(out).toContain("CODEX_HOME is a relative path (codex-home)");
    expect(readdirSync(home)).toEqual([]);
  });

  it("exits 1 for Claude Desktop on Linux and writes nothing", async () => {
    const system = homeSystem(home, { platform: "linux" });
    const code = await runInit([dir, ...BASE, "--write-user-config", "claude-desktop"], {
      system,
    });
    expect(code).toBe(1);
    expect(out).toContain("No user-level config location is known for Claude Desktop");
    expect(readdirSync(home)).toEqual([]);
  });

  it("exits 1 and names the file when the write fails", async () => {
    const file = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file, '{ "mcpServers": {} }\n');
    mkdirSync(`${file}.browxai-bak`);
    writeFileSync(join(`${file}.browxai-bak`, "x"), "");
    const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
      system: homeSystem(home),
    });
    expect(code).toBe(1);
    expect(out).toContain(`could not write ${file}`);
    expect(readFileSync(file, "utf8")).toBe('{ "mcpServers": {} }\n');
  });

  it.each([
    ["cursor", [".cursor", "mcp.json"]],
    ["codex", [".codex", "config.toml"]],
    ["claude-desktop", ["Library", "Application Support", "Claude", "claude_desktop_config.json"]],
  ] as const)("refuses plainly when the %s config path is a folder", async (client, parts) => {
    const file = join(home, ...parts);
    mkdirSync(file, { recursive: true });
    const code = await runInit([dir, ...BASE, "--write-user-config", client], {
      system: homeSystem(home),
    });
    expect(code).toBe(1);
    expect(out).toContain(`${file} can't be read (it is a folder): add the entry by hand with:`);
    expect(out).not.toContain("EISDIR");
    expect(out).not.toContain("    at ");
    expect(readdirSync(file)).toEqual([]);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("refuses plainly on a permission error and never prints file contents", async () => {
    const file = join(home, ".cursor", "mcp.json");
    const readConfig = (): string => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${file}' SECRET`), {
        code: "EACCES",
      });
    };
    const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
      system: homeSystem(home),
      readConfig,
    });
    expect(code).toBe(1);
    expect(out).toContain(`${file} can't be read (permission denied): add the entry by hand with:`);
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("Change to");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("refuses plainly when the write hits a read-only file system", async () => {
    const file = join(home, ".cursor", "mcp.json");
    const applyConfig = (): void => {
      throw Object.assign(new Error(`EROFS: read-only file system, open '${file}' SECRET`), {
        code: "EROFS",
      });
    };
    const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
      system: homeSystem(home),
      applyConfig,
    });
    expect(code).toBe(1);
    expect(out).toContain(`could not write ${file} (EROFS): add the entry by hand with:`);
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("Restart the client");
    expect(existsSync(file)).toBe(false);
  });

  it("keeps the old file as a backup and says to restart the client", async () => {
    const file = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file, '{ "mcpServers": {} }\n');
    const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
      system: homeSystem(home),
    });
    expect(code).toBe(0);
    expect(readFileSync(`${file}.browxai-bak`, "utf8")).toBe('{ "mcpServers": {} }\n');
    expect(out).toContain(`wrote ${file}. Restart the client to pick it up.`);
  });

  it.each([
    ["cursor", ".cursor"],
    ["codex", ".codex"],
    ["claude-desktop", "Library"],
  ])("prints the %s change and creates nothing under --no-write", async (client, created) => {
    const code = await runInit([dir, ...ARGS, "--write-user-config", client], {
      system: homeSystem(home),
    });
    expect(code).toBe(0);
    expect(out).toContain("not written (--no-write)");
    expect(existsSync(join(home, created))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  it("creates neither the workspace nor .mcp.json under --no-write --no-smoke", async () => {
    const smoke = vi.fn();
    const code = await runInit([dir, ...ARGS, "--no-smoke"], { smoke });
    expect(code).toBe(0);
    expect(smoke).not.toHaveBeenCalled();
    expect(existsSync(join(dir, ".browxai"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  it("prints the change before it writes, and both before the smoke test", async () => {
    const smoke = vi.fn().mockResolvedValue({ ok: true, message: "ok: smoke" });
    const code = await runInit(
      [dir, "--test-attrs", "data-testid", "--write-user-config", "cursor"],
      { system: homeSystem(home), smoke },
    );
    expect(code).toBe(0);
    const wrote = `wrote ${join(home, ".cursor", "mcp.json")}`;
    expect(out.indexOf("Change to")).toBeLessThan(out.indexOf(wrote));
    expect(out.indexOf(wrote)).toBeLessThan(out.indexOf("next steps:"));
    expect(out.indexOf("next steps:")).toBeLessThan(out.indexOf("checking that a headless"));
  });

  it("still runs the smoke test after a refusal, and exits 1", async () => {
    const smoke = vi.fn().mockResolvedValue({ ok: true, message: "ok: smoke" });
    const code = await runInit(
      [dir, "--test-attrs", "data-testid", "--write-user-config", "claude-code"],
      { system: homeSystem(home), smoke },
    );
    expect(code).toBe(1);
    expect(smoke).toHaveBeenCalledOnce();
    expect(out.trimEnd().endsWith("ok: smoke")).toBe(true);
  });

  it("exits 1 when the config was written and the smoke test failed", async () => {
    const smoke = vi.fn().mockResolvedValue({ ok: false, message: "error: no browser" });
    const code = await runInit(
      [dir, "--test-attrs", "data-testid", "--write-user-config", "cursor"],
      { system: homeSystem(home), smoke },
    );
    expect(code).toBe(1);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
    expect(out).toContain("error: no browser");
  });
});

describe("browxai init user-level config, on by default", () => {
  const BASE = ["--test-attrs", "data-testid", "--no-smoke"];
  const CURSOR = (home: string): string => join(home, ".cursor", "mcp.json");
  const CODEX = (home: string): string => join(home, ".codex", "config.toml");
  const DESKTOP = (home: string): string =>
    join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  let home: string;

  /** The real file system under a temp home, blind to apps installed on the host. */
  const sys = (): ClientSystem =>
    homeSystem(home, { exists: (p) => !p.startsWith("/Applications/") && existsSync(p) });

  /** A home where every writable client looks installed. */
  function installAll(): void {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "browxai-home-"));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("writes the config of every client it finds, with no flag", async () => {
    installAll();
    const code = await runInit([dir, ...BASE], { system: sys() });
    expect(code).toBe(0);
    const env = { BROWX_WORKSPACE: join(dir, ".browxai") };
    expect(JSON.parse(readFileSync(CURSOR(home), "utf8")).mcpServers.browxai.env).toMatchObject(
      env,
    );
    expect(JSON.parse(readFileSync(DESKTOP(home), "utf8")).mcpServers.browxai.command).toBe(
      process.execPath,
    );
    expect(readFileSync(CODEX(home), "utf8")).toContain("[mcp_servers.browxai]");
    expect(out.indexOf(`Change to ${CURSOR(home)}`)).toBeLessThan(
      out.indexOf(`wrote ${CURSOR(home)}`),
    );
  });

  it("creates the file when the client is installed and has none", async () => {
    mkdirSync(join(home, ".cursor"));
    expect(existsSync(CURSOR(home))).toBe(false);
    expect(await runInit([dir, ...BASE], { system: sys() })).toBe(0);
    expect(out).toContain("--- (new file)");
    expect(existsSync(CURSOR(home))).toBe(true);
    expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("writes nothing for a client it does not find", async () => {
    expect(await runInit([dir, ...BASE], { system: sys() })).toBe(0);
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("leaves Claude Code to its printed command", async () => {
    const system = homeSystem(home, {
      env: { PATH: "/bin" },
      exists: (p) => p === "/bin/claude",
    });
    expect(await runInit([dir, ...BASE], { system })).toBe(0);
    expect(out).toContain("claude mcp add-json");
    expect(out).not.toContain("Change to");
    expect(readdirSync(home)).toEqual([]);
  });

  it("writes none of it under --no-write-user-config, and still writes the project file", async () => {
    installAll();
    const code = await runInit([dir, ...BASE, "--no-write-user-config"], {
      system: sys(),
    });
    expect(code).toBe(0);
    expect(existsSync(CURSOR(home))).toBe(false);
    expect(existsSync(CODEX(home))).toBe(false);
    expect(existsSync(DESKTOP(home))).toBe(false);
    expect(out).not.toContain("Change to");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("still runs the smoke test under --no-write-user-config", async () => {
    const smoke = vi.fn().mockResolvedValue({ ok: true, message: "ok: smoke" });
    const args = [dir, "--test-attrs", "data-testid", "--no-write-user-config"];
    expect(await runInit(args, { system: sys(), smoke })).toBe(0);
    expect(smoke).toHaveBeenCalledOnce();
  });

  it("prints each change and writes none of it under --no-write", async () => {
    installAll();
    const code = await runInit([dir, ...ARGS], { system: sys() });
    expect(code).toBe(0);
    expect(out).toContain(`Change to ${CURSOR(home)}`);
    expect(out).toContain("not written (--no-write)");
    expect(existsSync(CURSOR(home))).toBe(false);
    expect(existsSync(CODEX(home))).toBe(false);
    expect(existsSync(DESKTOP(home))).toBe(false);
  });

  describe("--write-user-config", () => {
    it("with no client is a no-op: the result matches the default", async () => {
      installAll();
      const code = await runInit([dir, ...BASE, "--write-user-config"], {
        system: sys(),
      });
      expect(code).toBe(0);
      expect(existsSync(CURSOR(home))).toBe(true);
      expect(existsSync(CODEX(home))).toBe(true);
      expect(existsSync(DESKTOP(home))).toBe(true);
    });

    it("with no client may sit before another flag", async () => {
      installAll();
      const code = await runInit([dir, "--write-user-config", "--no-smoke"], {
        system: sys(),
      });
      expect(code).toBe(0);
      expect(existsSync(CURSOR(home))).toBe(true);
    });

    it("with a client writes that client only, as before", async () => {
      installAll();
      const code = await runInit([dir, ...BASE, "--write-user-config", "cursor"], {
        system: sys(),
      });
      expect(code).toBe(0);
      expect(existsSync(CURSOR(home))).toBe(true);
      expect(existsSync(CODEX(home))).toBe(false);
      expect(existsSync(DESKTOP(home))).toBe(false);
    });

    it("with a client still exits 1 when that client cannot be edited", async () => {
      installAll();
      const code = await runInit([dir, ...BASE, "--write-user-config", "claude-code"], {
        system: sys(),
      });
      expect(code).toBe(1);
      expect(existsSync(CURSOR(home))).toBe(false);
    });
  });

  describe("an existing file", () => {
    it("is merged: other servers stay and the old copy is kept", async () => {
      installAll();
      const original = JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" });
      writeFileSync(CURSOR(home), original);
      expect(await runInit([dir, ...BASE], { system: sys() })).toBe(0);
      const doc = JSON.parse(readFileSync(CURSOR(home), "utf8"));
      expect(doc.theme).toBe("dark");
      expect(doc.mcpServers.other).toEqual({ command: "x" });
      expect(doc.mcpServers.browxai.command).toBe(process.execPath);
      expect(readFileSync(`${CURSOR(home)}.browxai-bak`, "utf8")).toBe(original);
    });

    it("is appended to for Codex, keeping what is there", async () => {
      installAll();
      const original = 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n';
      writeFileSync(CODEX(home), original);
      expect(await runInit([dir, ...BASE], { system: sys() })).toBe(0);
      const text = readFileSync(CODEX(home), "utf8");
      expect(text.startsWith(original)).toBe(true);
      expect(text).toContain("[mcp_servers.browxai]");
      expect(readFileSync(`${CODEX(home)}.browxai-bak`, "utf8")).toBe(original);
    });

    it("with a browxai entry is left byte for byte, with no backup", async () => {
      installAll();
      const original = JSON.stringify({ mcpServers: { browxai: { command: "mine" } } });
      writeFileSync(CURSOR(home), original);
      expect(await runInit([dir, ...BASE], { system: sys() })).toBe(0);
      expect(out).toContain("already has a browxai entry, left as it is");
      expect(readFileSync(CURSOR(home), "utf8")).toBe(original);
      expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
    });

    it("that is not plain JSON is left alone, and the other clients are still written", async () => {
      installAll();
      const original = '{ // mine\n  "mcpServers": {}\n}\n';
      writeFileSync(CURSOR(home), original);
      const code = await runInit([dir, ...BASE], { system: sys() });
      expect(code).toBe(0);
      expect(out).toContain("is not plain JSON");
      expect(readFileSync(CURSOR(home), "utf8")).toBe(original);
      expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
      expect(existsSync(CODEX(home))).toBe(true);
      expect(existsSync(DESKTOP(home))).toBe(true);
    });

    it("whose write fails is named, and the run carries on without a failing exit", async () => {
      installAll();
      const applyConfig = vi.fn().mockImplementationOnce(() => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      });
      const code = await runInit([dir, ...BASE], {
        system: sys(),
        applyConfig,
        readConfig: () => undefined,
      });
      expect(code).toBe(0);
      expect(out).toContain("could not write");
      expect(applyConfig).toHaveBeenCalledTimes(3);
    });
  });
});

describe("browxai init client report", () => {
  it("says so when no client is installed", async () => {
    const system: ClientSystem = {
      platform: "darwin",
      home: "/h",
      env: { PATH: "/bin" },
      exists: () => false,
    };
    expect(await runInit([dir, ...ARGS], { system })).toBe(0);
    expect(out).toContain("No MCP client found on this machine");
    expect(out).not.toContain("--write-user-config <client>");
  });

  it("lists every client it finds and which of them it can write", async () => {
    const present = new Set([
      "/bin/claude",
      "/h/.cursor",
      "/h/.codex",
      "/h/Library/Application Support/Claude",
    ]);
    const system: ClientSystem = {
      platform: "darwin",
      home: "/h",
      env: { PATH: "/bin" },
      exists: (p) => present.has(p),
    };
    expect(await runInit([dir, ...ARGS], { system })).toBe(0);
    for (const label of ["Claude Code", "Cursor", "Codex", "Claude Desktop"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("--no-write");
  });

  it("says which files it edits and how to stop it, before it writes", async () => {
    const present = new Set(["/h/.cursor", "/h/.codex", "/h/Library/Application Support/Claude"]);
    const system: ClientSystem = {
      platform: "darwin",
      home: "/h",
      env: { PATH: "/bin" },
      exists: (p) => present.has(p),
    };
    const applyConfig = vi.fn();
    const args = [dir, "--test-attrs", "data-testid", "--no-smoke"];
    expect(await runInit(args, { system, applyConfig, readConfig: () => undefined })).toBe(0);
    expect(out).toContain("adds itself to the user-level config of cursor, codex, claude-desktop");
    expect(out).toContain("Pass --no-write-user-config to leave those files alone.");
    expect(applyConfig).toHaveBeenCalledTimes(3);
  });

  it("says how to turn the write back on under --no-write-user-config", async () => {
    const present = new Set(["/h/.cursor"]);
    const system: ClientSystem = {
      platform: "darwin",
      home: "/h",
      env: { PATH: "/bin" },
      exists: (p) => present.has(p),
    };
    const applyConfig = vi.fn();
    const args = [dir, "--test-attrs", "data-testid", "--no-smoke", "--no-write-user-config"];
    expect(await runInit(args, { system, applyConfig })).toBe(0);
    expect(out).toContain("Not editing the user-level config of cursor (--no-write-user-config)");
    expect(applyConfig).not.toHaveBeenCalled();
  });
});

describe("browxai init arguments", () => {
  let err = "";

  beforeEach(() => {
    err = "";
    vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
  });

  it.each([
    ["no arguments", []],
    ["--help", ["--help"]],
    ["-h", ["-h"]],
    ["only flags", ["--no-write"]],
    ["two workspaces", ["a", "b"]],
    ["a flag with a typo", ["w", "--no-writes"]],
    ["--test-attrs=value", ["w", "--test-attrs=data-testid"]],
    ["an unknown client", ["w", "--write-user-config", "vim"]],
    ["a workspace taken as the client", ["--write-user-config", "w"]],
    [
      "a client and --no-write-user-config",
      ["w", "--write-user-config", "cursor", "--no-write-user-config"],
    ],
  ])("prints usage and exits 2 for %s", async (_name, args) => {
    expect(await runInit(args)).toBe(2);
    expect(err).toContain("usage: browxai init <workspace>");
    expect(err).toContain("claude-code, cursor, codex, claude-desktop");
    expect(err).toContain("--no-write-user-config");
    expect(out).toBe("");
  });

  it("creates nothing when it prints usage", async () => {
    expect(await runInit([join(dir, "ws"), "--nope"])).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not overwrite an existing .mcp.json", async () => {
    writeFileSync(join(dir, ".mcp.json"), "mine\n");
    const args = [dir, "--test-attrs", "data-testid", "--no-smoke", "--no-write-user-config"];
    expect(await runInit(args)).toBe(0);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe("mine\n");
    expect(out).toContain("exists — printing snippet below");
  });
});
