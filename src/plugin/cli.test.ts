// `browxai plugin` CLI subcommands — unit tests for the dispatcher.
//
// The install/remove/upgrade/sync paths shell out to `pnpm` — we don't
// run a real pnpm in unit tests (no network, no on-disk packages).
// Instead the tests cover the dispatcher's argument handling,
// help text, and the list/info read paths that only touch local files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPackageManager, NO_PACKAGE_MANAGER_ERROR, pmArgs, runPlugin } from "./cli.js";

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
  it("emits help with no subcommand", async () => {
    const code = await runPlugin([]);
    expect(code).toBe(0);
    expect(stdoutLog.join("")).toMatch(/install <pkg>/);
    expect(stdoutLog.join("")).toMatch(/sync/);
  });

  it("emits help on --help", async () => {
    const code = await runPlugin(["--help"]);
    expect(code).toBe(0);
    expect(stdoutLog.join("")).toMatch(/Usage: browxai plugin/);
  });

  it("rejects unknown subcommands non-zero", async () => {
    const code = await runPlugin(["dance"]);
    expect(code).toBe(2);
    expect(stderrLog.join("")).toMatch(/unknown subcommand/);
  });

  it("install without arg → exit 1", async () => {
    const code = await runPlugin(["install"]);
    expect(code).toBe(1);
    expect(stderrLog.join("")).toMatch(/missing <pkg>/);
  });

  it("remove without arg → exit 1", async () => {
    const code = await runPlugin(["remove"]);
    expect(code).toBe(1);
  });

  it("info without arg → exit 1", async () => {
    const code = await runPlugin(["info"]);
    expect(code).toBe(1);
  });
});

describe("runPlugin list", () => {
  it("lists nothing when plugins.json is missing", async () => {
    const code = await runPlugin(["list"]);
    expect(code).toBe(0);
    expect(stdoutLog.join("")).toMatch(/no plugins declared/);
  });

  it("lists declared plugins from plugins.json", async () => {
    const decl = workspaceRoot;
    mkdirSync(decl, { recursive: true });
    writeFileSync(
      join(decl, "plugins.json"),
      JSON.stringify({ plugins: ["plugin-a", "plugin-b"] }),
    );
    const code = await runPlugin(["list"]);
    expect(code).toBe(0);
    const out = stdoutLog.join("");
    expect(out).toMatch(/plugin-a/);
    expect(out).toMatch(/plugin-b/);
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
  it("prefers pnpm when both managers are available", () => {
    expect(detectPackageManager(() => true)).toBe("pnpm");
  });

  it("falls back to npm when pnpm is missing", () => {
    expect(detectPackageManager((cmd) => cmd === "npm")).toBe("npm");
  });

  it("returns null when neither manager is on PATH", () => {
    expect(detectPackageManager(() => false)).toBeNull();
  });

  it("names both managers in the actionable no-PM error", () => {
    expect(NO_PACKAGE_MANAGER_ERROR).toMatch(/pnpm/);
    expect(NO_PACKAGE_MANAGER_ERROR).toMatch(/npm/);
    expect(NO_PACKAGE_MANAGER_ERROR).toMatch(/PATH/);
  });

  it("maps operations onto pnpm verbs unchanged", () => {
    expect(pmArgs("pnpm", "add", "@browxai/plugin-figma")).toEqual([
      "add",
      "@browxai/plugin-figma",
    ]);
    expect(pmArgs("pnpm", "remove", "x")).toEqual(["remove", "x"]);
    expect(pmArgs("pnpm", "update")).toEqual(["update"]);
    expect(pmArgs("pnpm", "install")).toEqual(["install"]);
  });

  it("maps operations onto npm's verb names", () => {
    expect(pmArgs("npm", "add", "@browxai/plugin-figma")).toEqual([
      "install",
      "@browxai/plugin-figma",
    ]);
    expect(pmArgs("npm", "remove", "x")).toEqual(["uninstall", "x"]);
    expect(pmArgs("npm", "update", "x")).toEqual(["update", "x"]);
    expect(pmArgs("npm", "install")).toEqual(["install"]);
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
