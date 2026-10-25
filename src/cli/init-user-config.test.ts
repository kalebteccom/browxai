import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientSystem, ServerEntry } from "./init-clients.js";
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

  it("does not edit Claude Code settings", () => {
    expect(planUserConfig("claude-code", ENTRY, sys).kind).toBe("refuse");
  });

  it("has no Claude Desktop path on Linux", () => {
    const linux = { ...sys, platform: "linux" as const };
    expect(planUserConfig("claude-desktop", ENTRY, linux).kind).toBe("refuse");
  });
});

describe("applyUserConfig", () => {
  it("writes the file and its parent directory, with no temp file left", () => {
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(JSON.parse(readFileSync(plan.path, "utf8")).mcpServers.browxai).toEqual(ENTRY);
    expect(existsSync(`${plan.path}.browxai-tmp`)).toBe(false);
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

  it.skipIf(process.platform === "win32")("creates a new file as 0600", () => {
    const plan = planUserConfig("cursor", ENTRY, sys);
    if (plan.kind !== "add") throw new Error("expected add");
    applyUserConfig(plan);
    expect(statSync(plan.path).mode & 0o777).toBe(0o600);
  });
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
});
