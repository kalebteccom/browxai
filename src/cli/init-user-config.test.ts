import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexToml, type ClientSystem, type ServerEntry } from "./init-clients.js";
import { applyUserConfig, lineDiff, planUserConfig } from "./init-user-config.js";

const ENTRY: ServerEntry = {
  command: "node",
  args: ["/opt/browxai/dist/cli.js"],
  env: { BROWX_WORKSPACE: "/work/.browxai" },
};

let home: string;
let sys: ClientSystem;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "browxai-userconfig-"));
  sys = { platform: "darwin", home, env: { PATH: "" }, exists: (p) => existsSync(p) };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("planUserConfig", () => {
  it("creates a Cursor config that does not exist yet", () => {
    const plan = planUserConfig("cursor", ENTRY, sys);
    expect(plan.kind).toBe("add");
    if (plan.kind !== "add") return;
    expect(plan.path).toBe(join(home, ".cursor", "mcp.json"));
    expect(plan.before).toBe("");
    expect(JSON.parse(plan.after).mcpServers.browxai.command).toBe("node");
  });

  it("keeps the other servers already in the file", () => {
    const before = JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" });
    const plan = planUserConfig("cursor", ENTRY, sys, () => before);
    if (plan.kind !== "add") throw new Error("expected add");
    const doc = JSON.parse(plan.after);
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.mcpServers.browxai.args).toEqual(["/opt/browxai/dist/cli.js"]);
    expect(doc.theme).toBe("dark");
  });

  it("leaves an existing browxai entry alone", () => {
    const before = JSON.stringify({ mcpServers: { browxai: { command: "mine" } } });
    expect(planUserConfig("claude-desktop", ENTRY, sys, () => before).kind).toBe("present");
  });

  it("refuses a file that is not plain JSON", () => {
    const plan = planUserConfig("cursor", ENTRY, sys, () => '{ // note\n "mcpServers": {} }');
    expect(plan.kind).toBe("refuse");
  });

  it("refuses an mcpServers value that is not an object", () => {
    const plan = planUserConfig("cursor", ENTRY, sys, () => '{ "mcpServers": [] }');
    expect(plan.kind).toBe("refuse");
  });

  it("appends a Codex table after what is there", () => {
    const plan = planUserConfig("codex", ENTRY, sys, () => 'model = "x"\n');
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.after.startsWith('model = "x"\n\n[mcp_servers.browxai]\n')).toBe(true);
  });

  it("sees an existing Codex browxai table", () => {
    const before = '[mcp_servers.browxai]\ncommand = "x"\n';
    expect(planUserConfig("codex", ENTRY, sys, () => before).kind).toBe("present");
  });

  it.each([
    ["an inline table", '[mcp_servers]\nbrowxai = { command = "x" }\n'],
    ["a dotted key", 'mcp_servers.browxai.command = "x"\n'],
    ["a quoted table name", "[mcp_servers.'browxai']\ncommand = \"x\"\n"],
    ["an inline mcp_servers", 'mcp_servers = { other = { command = "x" } }\n'],
    ["a quoted inline mcp_servers", '"mcp_servers" = {}\n'],
  ])("refuses a Codex config with %s and prints the table to add", (_name, before) => {
    const plan = planUserConfig("codex", ENTRY, sys, () => before);
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.message).toContain("[mcp_servers.browxai]");
    expect(plan.message).toContain('command = "node"');
  });

  it("appends to a Codex config with other mcp_servers tables", () => {
    const before = '[mcp_servers.other]\ncommand = "x"\n';
    expect(planUserConfig("codex", ENTRY, sys, () => before).kind).toBe("add");
  });

  it("uses an absolute CODEX_HOME", () => {
    const codexHome = join(home, "codex-home");
    const plan = planUserConfig("codex", ENTRY, { ...sys, env: { CODEX_HOME: codexHome } });
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.path).toBe(join(codexHome, "config.toml"));
  });

  it("refuses a relative CODEX_HOME", () => {
    const plan = planUserConfig("codex", ENTRY, { ...sys, env: { CODEX_HOME: "codex-home" } });
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.message).toContain("CODEX_HOME");
  });

  it("does not edit Claude Code settings", () => {
    expect(planUserConfig("claude-code", ENTRY, sys).kind).toBe("refuse");
  });

  it("has no Claude Desktop path on Linux", () => {
    const linux = { ...sys, platform: "linux" as const };
    expect(planUserConfig("claude-desktop", ENTRY, linux).kind).toBe("refuse");
  });

  it.each([
    ["an empty file", ""],
    ["a file of whitespace", "  \n\n"],
  ])("starts a new JSON document from %s", (_name, before) => {
    const plan = planUserConfig("cursor", ENTRY, sys, () => before);
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.before).toBe(before);
    expect(plan.after).toBe(JSON.stringify({ mcpServers: { browxai: ENTRY } }, null, 2) + "\n");
  });

  it("writes two-space JSON with a final newline, other keys first", () => {
    const plan = planUserConfig("cursor", ENTRY, sys, () => '{"theme":"dark"}');
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.after).toBe(
      JSON.stringify({ theme: "dark", mcpServers: { browxai: ENTRY } }, null, 2) + "\n",
    );
  });

  it.each([
    ["a trailing comma", '{ "mcpServers": {}, }'],
    ["a block comment", '/* x */ { "mcpServers": {} }'],
    ["a truncated file", '{ "mcpServers": '],
    ["an array", "[]"],
    ["an array of objects", '[{ "mcpServers": {} }]'],
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"mcpServers"'],
  ])("refuses %s, naming the file", (_name, before) => {
    const plan = planUserConfig("cursor", ENTRY, sys, () => before);
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.message).toContain(join(home, ".cursor", "mcp.json"));
    expect(plan.message).toContain("is not plain JSON");
  });

  it.each([
    ["null", "null"],
    ["a string", '"x"'],
    ["a number", "3"],
    ["an array", "[]"],
  ])("refuses an mcpServers value that is %s", (_name, value) => {
    const plan = planUserConfig("cursor", ENTRY, sys, () => `{ "mcpServers": ${value} }`);
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") return;
    expect(plan.message).toContain('"mcpServers" in');
  });

  it("leaves an existing browxai entry alone for every JSON client", () => {
    const before = JSON.stringify({ mcpServers: { browxai: ENTRY } });
    for (const id of ["cursor", "claude-desktop"] as const) {
      const plan = planUserConfig(id, ENTRY, sys, () => before);
      expect(plan.kind).toBe("present");
    }
  });

  it("names the file in a present result", () => {
    const before = JSON.stringify({ mcpServers: { browxai: { command: "mine" } } });
    const plan = planUserConfig("cursor", ENTRY, sys, () => before);
    expect(plan).toEqual({ kind: "present", path: join(home, ".cursor", "mcp.json") });
  });

  it("places Claude Desktop under Application Support on macOS", () => {
    const plan = planUserConfig("claude-desktop", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.path).toBe(
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
  });

  it("places Claude Desktop under APPDATA on Windows, and refuses without it", () => {
    const appData = join(home, "AppData");
    const win = { ...sys, platform: "win32" as const, env: { APPDATA: appData } };
    const plan = planUserConfig("claude-desktop", ENTRY, win);
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.path).toBe(join(appData, "Claude", "claude_desktop_config.json"));
    const bare = planUserConfig("claude-desktop", ENTRY, { ...win, env: {} });
    expect(bare.kind).toBe("refuse");
    if (bare.kind !== "refuse") return;
    expect(bare.message).toBe(
      "No user-level config location is known for Claude Desktop on this OS.",
    );
  });

  it("points a Claude Code refusal at the add-json command", () => {
    const plan = planUserConfig("claude-code", ENTRY, sys);
    if (plan.kind !== "refuse") throw new Error("expected refuse");
    expect(plan.message).toContain("claude mcp add-json");
  });

  it("starts a Codex file from the table alone when there is none", () => {
    const plan = planUserConfig("codex", ENTRY, sys, () => "");
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.after).toBe(codexToml(ENTRY) + "\n");
  });

  it("separates a Codex table from a last line with no newline by a blank line", () => {
    const plan = planUserConfig("codex", ENTRY, sys, () => 'model = "x"');
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.after).toBe(`model = "x"\n\n${codexToml(ENTRY)}\n`);
  });

  it.each([
    ["a spaced header", '[ mcp_servers . "browxai" ]\ncommand = "x"\n'],
    ["a sub-table", '[mcp_servers.browxai.env]\nTOKEN = "x"\n'],
  ])("sees an existing Codex browxai table written as %s", (_name, before) => {
    expect(planUserConfig("codex", ENTRY, sys, () => before).kind).toBe("present");
  });

  it("refuses a Codex config that mentions browxai in a comment", () => {
    const plan = planUserConfig("codex", ENTRY, sys, () => "# BrowxAI goes here\n");
    expect(plan.kind).toBe("refuse");
  });

  it("refuses a Codex config with an indented inline mcp_servers", () => {
    const plan = planUserConfig("codex", ENTRY, sys, () => "  mcp_servers = {}\n");
    expect(plan.kind).toBe("refuse");
  });

  it("appends to a Codex config that has a bare [mcp_servers] header", () => {
    const before = '[mcp_servers]\n\n[mcp_servers.other]\ncommand = "x"\n';
    expect(planUserConfig("codex", ENTRY, sys, () => before).kind).toBe("add");
  });

  it("trims a CODEX_HOME and names a relative one in the refusal", () => {
    const codexHome = join(home, "codex-home");
    const padded = planUserConfig("codex", ENTRY, {
      ...sys,
      env: { CODEX_HOME: `  ${codexHome} ` },
    });
    if (padded.kind !== "add") throw new Error("expected add");
    expect(padded.path).toBe(join(codexHome, "config.toml"));
    const rel = planUserConfig("codex", ENTRY, { ...sys, env: { CODEX_HOME: "  rel " } });
    if (rel.kind !== "refuse") throw new Error("expected refuse");
    expect(rel.message).toContain("(rel)");
  });

  it("refuses a file one line over the limit and takes one at the limit", () => {
    const over = planUserConfig("codex", ENTRY, sys, () => "a = 1\n".repeat(3000));
    expect(over.kind).toBe("refuse");
    if (over.kind !== "refuse") return;
    expect(over.message).toContain("too large to show a diff");
    const at = planUserConfig("codex", ENTRY, sys, () => "a = 1\n".repeat(2999) + "a = 1");
    expect(at.kind).toBe("add");
  });

  it("reads the config file from disk when no reader is given", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), '{ "mcpServers": { "other": {} } }\n');
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    expect(plan.before).toBe('{ "mcpServers": { "other": {} } }\n');
    expect(JSON.parse(plan.after).mcpServers.other).toEqual({});
  });
});

describe("applyUserConfig", () => {
  it("writes the file and its parent directory, with no temp file left", () => {
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(JSON.parse(readFileSync(plan.path, "utf8")).mcpServers.browxai).toEqual(ENTRY);
    expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("removes its temp file and keeps the old config when the rename fails with EROFS", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, '{ "mcpServers": {} }\n');
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    const rename = (): void => {
      throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
    };
    expect(() => applyUserConfig(plan, rename)).toThrow(/EROFS/);
    expect(readFileSync(path, "utf8")).toBe('{ "mcpServers": {} }\n');
    expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("replaces an existing file", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, '{ "mcpServers": {} }\n');
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(readFileSync(path, "utf8")).toContain('"browxai"');
  });

  it.skipIf(process.platform === "win32")("keeps the mode of the file it replaces", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, '{ "mcpServers": { "other": { "env": { "TOKEN": "x" } } } }\n');
    chmodSync(path, 0o600);
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.other.env.TOKEN).toBe("x");
  });

  it("keeps the previous contents as a backup", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, '{ "mcpServers": {} }\n');
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(readFileSync(`${path}.browxai-bak`, "utf8")).toBe('{ "mcpServers": {} }\n');
    expect(readdirSync(join(home, ".cursor")).sort()).toEqual(["mcp.json", "mcp.json.browxai-bak"]);
  });

  it.skipIf(process.platform === "win32")(
    "does not write through a symlink at the old temp name",
    () => {
      const path = join(home, ".cursor", "mcp.json");
      mkdirSync(join(home, ".cursor"));
      const other = join(home, "other.txt");
      writeFileSync(other, "keep me\n");
      symlinkSync(other, `${path}.browxai-tmp`);
      const plan = planUserConfig("cursor", ENTRY, sys);
      if (plan.kind !== "add") throw new Error("expected add");
      applyUserConfig(plan);
      expect(readFileSync(other, "utf8")).toBe("keep me\n");
      expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.browxai).toEqual(ENTRY);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a symlinked config a symlink and replaces its file",
    () => {
      const real = join(home, "dotfiles", "mcp.json");
      mkdirSync(join(home, "dotfiles"));
      mkdirSync(join(home, ".cursor"));
      writeFileSync(real, '{ "mcpServers": {} }\n');
      chmodSync(real, 0o600);
      const link = join(home, ".cursor", "mcp.json");
      symlinkSync(real, link);
      const plan = planUserConfig("cursor", ENTRY, sys);
      if (plan.kind !== "add") throw new Error("expected add");
      applyUserConfig(plan);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(real);
      expect(JSON.parse(readFileSync(real, "utf8")).mcpServers.browxai).toEqual(ENTRY);
      expect(statSync(real).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
    },
  );

  it("removes its temp file and leaves the config alone when the write fails", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, '{ "mcpServers": {} }\n');
    // A non-empty directory where the backup goes makes the rename fail.
    mkdirSync(`${path}.browxai-bak`);
    writeFileSync(join(`${path}.browxai-bak`, "x"), "");
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    expect(() => applyUserConfig(plan)).toThrow();
    expect(readFileSync(path, "utf8")).toBe('{ "mcpServers": {} }\n');
    expect(readdirSync(join(home, ".cursor")).sort()).toEqual(["mcp.json", "mcp.json.browxai-bak"]);
  });

  it.skipIf(process.platform === "win32")("creates a new file as 0600", () => {
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(statSync(plan.path).mode & 0o777).toBe(0o600);
  });

  it("keeps the mode of the file on its backup too", () => {
    if (process.platform === "win32") return;
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, '{ "mcpServers": {} }\n');
    chmodSync(path, 0o640);
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(statSync(`${path}.browxai-bak`).mode & 0o777).toBe(0o640);
  });

  it("replaces an older backup with the contents before this write", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, "first\n");
    applyUserConfig({ kind: "add", path, before: "first\n", after: "second\n" });
    applyUserConfig({ kind: "add", path, before: "second\n", after: "third\n" });
    expect(readFileSync(path, "utf8")).toBe("third\n");
    expect(readFileSync(`${path}.browxai-bak`, "utf8")).toBe("second\n");
  });

  it("copies the backup byte for byte", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
    writeFileSync(path, bytes);
    applyUserConfig({ kind: "add", path, before: "", after: "{}\n" });
    expect(readFileSync(`${path}.browxai-bak`).equals(bytes)).toBe(true);
  });

  it("appends to an existing Codex file and keeps what was in it", () => {
    const path = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"));
    writeFileSync(path, 'model = "x"\n');
    const plan = planUserConfig("codex", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(readFileSync(path, "utf8")).toBe(`model = "x"\n\n${codexToml(ENTRY)}\n`);
    expect(readFileSync(`${path}.browxai-bak`, "utf8")).toBe('model = "x"\n');
  });

  it.skipIf(process.platform === "win32")("refuses a symlink to a file that is not there", () => {
    const link = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    const missing = join(home, "missing.json");
    symlinkSync(missing, link);
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    expect(() => applyUserConfig(plan)).toThrow(/symlink to a file that does not exist/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("throws and writes nothing when the config path is a directory", () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(path, { recursive: true });
    expect(() => applyUserConfig({ kind: "add", path, before: "", after: "{}\n" })).toThrow(
      /EISDIR/,
    );
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
    expect(readdirSync(path)).toEqual([]);
  });

  it("throws when the parent path is a file", () => {
    writeFileSync(join(home, ".cursor"), "not a directory");
    const path = join(home, ".cursor", "mcp.json");
    expect(() => applyUserConfig({ kind: "add", path, before: "", after: "{}\n" })).toThrow();
    expect(readFileSync(join(home, ".cursor"), "utf8")).toBe("not a directory");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "leaves the config and no temp file when its directory is read-only",
    () => {
      const dir = join(home, ".cursor");
      const path = join(dir, "mcp.json");
      mkdirSync(dir);
      writeFileSync(path, '{ "mcpServers": {} }\n');
      chmodSync(dir, 0o500);
      try {
        expect(() => applyUserConfig({ kind: "add", path, before: "", after: "{}\n" })).toThrow(
          /EACCES/,
        );
        expect(readFileSync(path, "utf8")).toBe('{ "mcpServers": {} }\n');
        expect(readdirSync(dir)).toEqual(["mcp.json"]);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces a read-only file and keeps it read-only",
    () => {
      const path = join(home, ".cursor", "mcp.json");
      mkdirSync(join(home, ".cursor"));
      writeFileSync(path, '{ "mcpServers": {} }\n');
      chmodSync(path, 0o400);
      const plan = planUserConfig("cursor", ENTRY, sys);
      if (plan.kind !== "add") throw new Error("expected add");
      applyUserConfig(plan);
      expect(statSync(path).mode & 0o777).toBe(0o400);
      expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.browxai).toEqual(ENTRY);
    },
  );
});

describe("lineDiff", () => {
  it("marks added lines and names the file", () => {
    const diff = lineDiff("a\nb\n", "a\nb\nc\n", "/f");
    expect(diff).toContain("+++ /f");
    expect(diff).toContain("+ c");
    expect(diff).not.toContain("- ");
  });

  it("shows a new file as all additions", () => {
    const diff = lineDiff("", "x\ny\n", "/f");
    expect(diff).toContain("--- (new file)");
    expect(diff).toContain("+ x");
    expect(diff).toContain("+ y");
  });

  it("shows a changed line as a removal and an addition, with context", () => {
    const diff = lineDiff("1\n2\n3\n4\n5\n6\n7\n8\n", "1\n2\n3\nfour\n5\n6\n7\n8\n", "/f");
    expect(diff).toContain("- 4");
    expect(diff).toContain("+ four");
    expect(diff).toContain("  3");
    expect(diff).toContain("  ...");
  });

  it("prints only the two headers when nothing changed", () => {
    expect(lineDiff("a\nb\n", "a\nb\n", "/f")).toBe("--- /f\n+++ /f");
  });

  it("shows a removed line between its neighbours", () => {
    expect(lineDiff("a\nb\nc\n", "a\nc\n", "/f")).toBe("--- /f\n+++ /f\n  a\n- b\n  c");
  });

  it("skips unchanged lines far from a change, with one gap marker per run", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n";
    const after = "one\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\ntwelve\n";
    const lines = lineDiff(before, after, "/f").split("\n");
    expect(lines.filter((l) => l === "  ...")).toHaveLength(1);
    expect(lines).toContain("  3");
    expect(lines).toContain("  10");
    expect(lines).not.toContain("  5");
    expect(lines).not.toContain("  8");
    expect(lines).toContain("+ one");
    expect(lines).toContain("- 12");
  });
});
