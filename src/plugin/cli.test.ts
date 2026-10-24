// `browxai plugin` CLI subcommands — unit tests for the dispatcher.
//
// The install/remove/upgrade/sync paths shell out to `pnpm` — we don't
// run a real pnpm in unit tests (no network, no on-disk packages).
// Instead the tests cover the dispatcher's argument handling,
// help text, and the list/info read paths that only touch local files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPackageManager, pmArgs, runPlugin } from "./cli.js";

let workspaceRoot: string;
let originalEnv: string | undefined;
let stdoutLog: string[];
let stderrLog: string[];
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "browxai-plugin-cli-"));
  originalEnv = process.env.BROWX_WORKSPACE;
  process.env.BROWX_WORKSPACE = workspaceRoot;
  stdoutLog = [];
  stderrLog = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: unknown): boolean => {
    stdoutLog.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderrLog.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  };
});

afterEach(() => {
  process.env.BROWX_WORKSPACE = originalEnv;
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  rmSync(workspaceRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runPlugin dispatcher", () => {
  it.each([
    {
      label: "emits help with no subcommand",
      argv: [],
      code: 0,
      stream: "out",
      match: [/install <pkg>/, /sync/],
    },
    {
      label: "rejects unknown subcommands non-zero",
      argv: ["dance"],
      code: 2,
      stream: "err",
      match: [/unknown subcommand/],
    },
    {
      label: "install without an arg exits 1",
      argv: ["install"],
      code: 1,
      stream: "err",
      match: [/missing <pkg>/],
    },
  ])("$label", async ({ argv, code, stream, match }) => {
    expect(await runPlugin(argv)).toBe(code);
    const text = (stream === "out" ? stdoutLog : stderrLog).join("");
    for (const re of match) expect(text).toMatch(re);
  });
});

describe("runPlugin list", () => {
  it("lists nothing when plugins.json is missing", async () => {
    const code = await runPlugin(["list"]);
    expect(code).toBe(0);
    expect(stdoutLog.join("")).toMatch(/no plugins declared/);
  });

  it("reflects [disabled] on entries marked enabled:false", async () => {
    const decl = workspaceRoot;
    mkdirSync(decl, { recursive: true });
    writeFileSync(
      join(decl, "plugins.json"),
      JSON.stringify({
        plugins: {
          "plugin-a": { enabled: false },
          "plugin-b": { enabled: true },
        },
      }),
    );
    const code = await runPlugin(["list"]);
    expect(code).toBe(0);
    const out = stdoutLog.join("");
    expect(out).toMatch(/plugin-a.*\[disabled\]/);
  });

  it("reflects the lock-file version when present", async () => {
    const decl = workspaceRoot;
    mkdirSync(decl, { recursive: true });
    writeFileSync(join(decl, "plugins.json"), JSON.stringify({ plugins: ["plugin-a"] }));
    writeFileSync(
      join(decl, "plugins-lock.json"),
      JSON.stringify({
        lockfileVersion: 1,
        entries: {
          "plugin-a": { name: "plugin-a", version: "1.2.3", source: "npm", contentSha256: "abc" },
        },
      }),
    );
    const code = await runPlugin(["list"]);
    expect(code).toBe(0);
    expect(stdoutLog.join("")).toMatch(/1\.2\.3/);
  });
});

describe("package-manager detection + verb mapping", () => {
  it.each([
    { label: "prefers pnpm when both managers are available", has: () => true, expected: "pnpm" },
    {
      label: "falls back to npm when pnpm is missing",
      has: (cmd: string) => cmd === "npm",
      expected: "npm",
    },
    { label: "returns null when neither manager is on PATH", has: () => false, expected: null },
  ])("$label", ({ has, expected }) => {
    expect(detectPackageManager(has)).toBe(expected);
  });

  it.each([
    {
      label: "npm add puts the spec after -- with scripts off",
      pm: "npm",
      op: "add",
      spec: "@browxai/plugin-figma",
      expected: ["install", "--ignore-scripts", "--", "@browxai/plugin-figma"],
    },
    {
      label: "npm remove maps to uninstall",
      pm: "npm",
      op: "remove",
      spec: "x",
      expected: ["uninstall", "--", "x"],
    },
    {
      label: "npm install without a spec",
      pm: "npm",
      op: "install",
      spec: undefined,
      expected: ["install", "--ignore-scripts"],
    },
    {
      label: "pnpm add puts the spec after -- with scripts off",
      pm: "pnpm",
      op: "add",
      spec: "file:/tmp/p",
      expected: ["add", "--ignore-scripts", "--", "file:/tmp/p"],
    },
  ] as const)("$label", ({ pm, op, spec, expected }) => {
    expect(pmArgs(pm, op, spec)).toEqual(expected);
  });

  it("refuses a spec that starts with a dash", () => {
    expect(() => pmArgs("pnpm", "add", "--global")).toThrow(/never starts with "-"/);
    expect(() => pmArgs("npm", "remove", "-g")).toThrow(/never starts with "-"/);
  });
});

describe("runPlugin with a spec that starts with a dash", () => {
  it.each([
    ["install", "-g"],
    ["remove", "--global"],
    ["upgrade", "--latest"],
  ])("%s %s exits 2 and leaves the workspace alone", async (verb, spec) => {
    const code = await runPlugin([verb, spec]);
    expect(code).toBe(2);
    expect(stderrLog.join("")).toMatch(/never starts with "-"/);
    expect(existsSync(join(workspaceRoot, "plugins"))).toBe(false);
    expect(existsSync(join(workspaceRoot, "plugins.json"))).toBe(false);
  });
});

describe("runPlugin info", () => {
  it("emits 1 when the plugin isn't declared", async () => {
    const code = await runPlugin(["info", "plugin-x"]);
    expect(code).toBe(1);
    expect(stderrLog.join("")).toMatch(/not declared/);
  });

  it("emits a structured info dump when the plugin is declared + installed", async () => {
    const decl = workspaceRoot;
    mkdirSync(decl, { recursive: true });
    writeFileSync(join(decl, "plugins.json"), JSON.stringify({ plugins: ["plugin-a"] }));
    const pkgRoot = join(decl, "plugins", "node_modules", "plugin-a");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "plugin-a",
        version: "1.0.0",
        description: "tiny",
        browxai: { apiVersion: "1.0.0", namespace: "a", register: "index.js" },
      }),
    );
    const code = await runPlugin(["info", "plugin-a"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdoutLog.join("")) as Record<string, unknown>;
    expect(out.declared).toBeDefined();
    expect((out.manifest as Record<string, unknown>).name).toBe("plugin-a");
  });
});
