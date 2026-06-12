// `browxai doctor` plugins section — every ✓ / ✗ / − branch.
//
// Pure-inspection unit tests: fixture plugin dirs + plugins.json /
// plugins-lock.json in a tmp workspace (same fixture style as
// src/plugin/resolver.test.ts). No plugin code is ever executed —
// the entry module bodies in these fixtures would throw if imported.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginChecks } from "./doctor-plugins.js";
import type { Check } from "./doctor.js";
import { pluginPaths } from "../plugin/resolver.js";
import { sha256OfPackage, type LockEntry } from "../plugin/cli.js";
import { DEFAULT_CAPABILITIES, type Capability } from "../util/capabilities.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "browxai-doctor-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const DEFAULTS: ReadonlySet<Capability> = new Set(DEFAULT_CAPABILITIES);

function run(opts?: {
  enabled?: ReadonlySet<Capability>;
  extraDeclared?: ReadonlyArray<string>;
}): Check[] {
  return pluginChecks({
    workspaceRoot: root,
    enabledCapabilities: opts?.enabled ?? DEFAULTS,
    ...(opts?.extraDeclared ? { extraDeclared: opts.extraDeclared } : {}),
  });
}

function declare(plugins: Record<string, { enabled?: boolean; trust?: string }>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "plugins.json"), JSON.stringify({ plugins }, null, 2));
}

interface InstallOpts {
  version?: string;
  namespace?: string;
  apiVersion?: string;
  capabilities?: string[];
  dependsOn?: Array<{ plugin: string; version: string }>;
  /** false = write a package.json WITHOUT the browxai field. */
  browxai?: boolean;
}

function install(name: string, opts: InstallOpts = {}): string {
  const paths = pluginPaths(root);
  const pkgRoot = join(paths.nodeModulesDir, name);
  mkdirSync(pkgRoot, { recursive: true });
  const browxai =
    opts.browxai === false
      ? {}
      : {
          browxai: {
            apiVersion: opts.apiVersion ?? "1.0.0",
            namespace: opts.namespace ?? (name.replace(/[^a-z0-9_]/g, "").slice(0, 12) || "ns"),
            register: "index.js",
            capabilities: opts.capabilities ?? [],
            dependsOn: opts.dependsOn ?? [],
          },
        };
  writeFileSync(
    join(pkgRoot, "package.json"),
    JSON.stringify({ name, version: opts.version ?? "1.0.0", ...browxai }, null, 2),
  );
  // Would throw if doctor ever executed it — doctor must never import this.
  writeFileSync(join(pkgRoot, "index.js"), "throw new Error('doctor must not execute plugins');");
  return pkgRoot;
}

function writeLockFile(entries: Record<string, LockEntry>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "plugins-lock.json"),
    JSON.stringify({ lockfileVersion: 1, entries }, null, 2),
  );
}

function pinFor(name: string, overrides: Partial<LockEntry> = {}): LockEntry {
  const pkgRoot = join(pluginPaths(root).nodeModulesDir, name);
  return {
    name,
    version: "1.0.0",
    source: name,
    contentSha256: sha256OfPackage(pkgRoot),
    ...overrides,
  };
}

const fails = (checks: Check[]): Check[] => checks.filter((c) => !c.ok);
const find = (checks: Check[], re: RegExp): Check | undefined =>
  checks.find((c) => re.test(c.detail));

describe("declaration file states", () => {
  it("− informational (not a failure) when plugins.json is absent", () => {
    const checks = run();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ ok: true, info: true });
    expect(checks[0]!.detail).toMatch(/no plugins declared/);
    expect(checks[0]!.detail).toMatch(/absent/);
  });

  it("− informational when plugins.json declares nothing", () => {
    declare({});
    const checks = run();
    const row = find(checks, /no plugins declared/);
    expect(row).toMatchObject({ ok: true, info: true });
    expect(fails(checks)).toHaveLength(0);
  });

  it("✗ when plugins.json is malformed JSON, with a fix pointing at the file", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "plugins.json"), "{not json");
    const checks = run();
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/plugins\.json malformed/);
    expect(checks[0]!.fix).toContain(join(root, "plugins.json"));
  });

  it("✓ declaration summary counts the declared set", () => {
    declare({ "plugin-a": {}, "plugin-b": {} });
    install("plugin-a", { namespace: "a" });
    install("plugin-b", { namespace: "b" });
    writeLockFile({ "plugin-a": pinFor("plugin-a"), "plugin-b": pinFor("plugin-b") });
    const checks = run();
    expect(find(checks, /plugins\.json: 2 declared/)).toMatchObject({ ok: true });
  });
});

describe("declared-plugin drift", () => {
  it("✗ declared but not installed → browxai plugin sync", () => {
    declare({ "plugin-missing": {} });
    const checks = run();
    const row = find(checks, /plugin-missing declared but not installed/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("browxai plugin sync");
  });

  it("− declared but disabled is informational and skips validation", () => {
    declare({ "plugin-off": { enabled: false } });
    const checks = run();
    const row = find(checks, /plugin-off declared but disabled/);
    expect(row).toMatchObject({ ok: true, info: true });
    // No not-installed ✗ for a disabled plugin.
    expect(fails(checks).filter((c) => c.detail.includes("plugin-off"))).toHaveLength(0);
  });

  it("✓ healthy plugin row carries name@version, namespace and lock state", () => {
    declare({ "plugin-good": {} });
    install("plugin-good", { namespace: "good", version: "2.1.0" });
    writeLockFile({ "plugin-good": pinFor("plugin-good", { version: "2.1.0" }) });
    const checks = run();
    const row = find(checks, /plugin-good@2\.1\.0/);
    expect(row?.ok).toBe(true);
    expect(row?.detail).toContain("ns=good");
    expect(row?.detail).toContain("lock ok");
    expect(fails(checks)).toHaveLength(0);
  });

  it("treats config-store-declared (set_config) plugins as declared, not orphans", () => {
    install("plugin-extra", { namespace: "extra" });
    const checks = run({ extraDeclared: ["plugin-extra"] });
    expect(find(checks, /declared via set_config/)).toMatchObject({ ok: true });
    expect(find(checks, /orphan/)).toBeUndefined();
    // No lock complaints either — the lock only pins file-declared plugins.
    expect(fails(checks)).toHaveLength(0);
  });
});

describe("orphan installs", () => {
  it("✗ installed-but-not-declared plugin → remove (or declare)", () => {
    declare({ "plugin-good": {} });
    install("plugin-good", { namespace: "good" });
    writeLockFile({ "plugin-good": pinFor("plugin-good") });
    install("@scope/plugin-orphan", { namespace: "orphan" });
    const checks = run();
    const row = find(checks, /orphan install: @scope\/plugin-orphan/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("browxai plugin remove @scope/plugin-orphan");
    expect(row?.fix).toMatch(/declare it/);
  });

  it("ignores plain dependencies (no browxai field) in the install dir", () => {
    declare({ "plugin-good": {} });
    install("plugin-good", { namespace: "good" });
    writeLockFile({ "plugin-good": pinFor("plugin-good") });
    install("zod", { browxai: false });
    const checks = run();
    expect(find(checks, /orphan/)).toBeUndefined();
    expect(fails(checks)).toHaveLength(0);
  });
});

describe("lock health", () => {
  it("✗ plugins-lock.json missing while plugins are declared → sync", () => {
    declare({ "plugin-good": {} });
    install("plugin-good", { namespace: "good" });
    const checks = run();
    const row = find(checks, /plugins-lock\.json missing/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("browxai plugin sync");
  });

  it("✗ sha256 mismatch vs the installed package is loud and fail-closed", () => {
    declare({ "plugin-good": {} });
    install("plugin-good", { namespace: "good" });
    writeLockFile({ "plugin-good": pinFor("plugin-good", { contentSha256: "deadbeef" }) });
    const checks = run();
    const row = find(checks, /contentSha256 MISMATCH/);
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/NOT what was pinned/);
    expect(row?.fix).toMatch(/do not trust the install until audited/);
    expect(row?.fix).toContain("browxai plugin sync");
  });

  it("✗ installed + declared plugin missing its lock pin → sync", () => {
    declare({ "plugin-good": {} });
    install("plugin-good", { namespace: "good" });
    writeLockFile({});
    const checks = run();
    const row = find(checks, /no pin in plugins-lock\.json/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("browxai plugin sync");
  });

  it("✗ stale lock entry for an undeclared plugin", () => {
    declare({ "plugin-good": {} });
    install("plugin-good", { namespace: "good" });
    writeLockFile({
      "plugin-good": pinFor("plugin-good"),
      "plugin-ghost": {
        name: "plugin-ghost",
        version: "1.0.0",
        source: "plugin-ghost",
        contentSha256: "abc",
      },
    });
    const checks = run();
    const row = find(checks, /stale lock entry: plugin-ghost/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("browxai plugin remove plugin-ghost");
  });
});

describe("manifest sanity (no code execution)", () => {
  it("✗ invalid manifest (package.json lacks browxai field)", () => {
    declare({ "plugin-plain": {} });
    install("plugin-plain", { browxai: false });
    const checks = run();
    const row = find(checks, /plugin-plain invalid manifest/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("package.json#browxai");
  });

  it("✗ apiVersion incompatible with RUNTIME_API_VERSION", () => {
    declare({ "plugin-future": {} });
    install("plugin-future", { namespace: "future", apiVersion: "2.0.0" });
    writeLockFile({ "plugin-future": pinFor("plugin-future") });
    const checks = run();
    const row = find(checks, /apiVersion "2\.0\.0" incompatible with runtime apiVersion "1\.0\.0"/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toMatch(/upgrade the plugin/);
  });

  it("✗ duplicate namespace across the declared set names both plugins", () => {
    declare({ "plugin-a": {}, "plugin-b": {} });
    install("plugin-a", { namespace: "shared" });
    install("plugin-b", { namespace: "shared" });
    writeLockFile({ "plugin-a": pinFor("plugin-a"), "plugin-b": pinFor("plugin-b") });
    const checks = run();
    const row = find(checks, /plugin-b namespace "shared" already claimed by plugin-a/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toMatch(/rename one/);
    // First claimer stays healthy.
    expect(find(checks, /plugin-a@1\.0\.0/)?.ok).toBe(true);
  });

  it("✗ capability mismatch names the missing capability in the fix hint", () => {
    declare({ "plugin-canvas": {} });
    install("plugin-canvas", { namespace: "cv", capabilities: ["eval", "canvas"] });
    writeLockFile({ "plugin-canvas": pinFor("plugin-canvas") });
    const checks = run();
    const row = find(checks, /capability\(ies\) \[eval, canvas\] not enabled/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("add eval,canvas to BROWX_CAPABILITIES");
    expect(row?.fix).toMatch(/restart/);
  });

  it("✓ capability subset passes when the operator enabled it", () => {
    declare({ "plugin-canvas": {} });
    install("plugin-canvas", { namespace: "cv", capabilities: ["eval", "canvas"] });
    writeLockFile({ "plugin-canvas": pinFor("plugin-canvas") });
    const enabled = new Set<Capability>([...DEFAULT_CAPABILITIES, "eval", "canvas"]);
    const checks = run({ enabled });
    expect(fails(checks)).toHaveLength(0);
    expect(find(checks, /plugin-canvas@1\.0\.0/)?.ok).toBe(true);
  });

  it("✗ dependsOn target not resolvable", () => {
    declare({ "plugin-a": {} });
    install("plugin-a", {
      namespace: "a",
      dependsOn: [{ plugin: "plugin-b", version: "^1.0.0" }],
    });
    writeLockFile({ "plugin-a": pinFor("plugin-a") });
    const checks = run();
    const row = find(checks, /dependsOn\["plugin-b"\] is not resolvable/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("browxai plugin install plugin-b");
  });

  it("✗ dependsOn version range unsatisfied", () => {
    declare({ "plugin-a": {}, "plugin-b": {} });
    install("plugin-a", {
      namespace: "a",
      dependsOn: [{ plugin: "plugin-b", version: "^2.0.0" }],
    });
    install("plugin-b", { namespace: "b", version: "1.0.0" });
    writeLockFile({ "plugin-a": pinFor("plugin-a"), "plugin-b": pinFor("plugin-b") });
    const checks = run();
    const row = find(checks, /installed version 1\.0\.0 does not satisfy range "\^2\.0\.0"/);
    expect(row?.ok).toBe(false);
    expect(row?.fix).toContain("browxai plugin upgrade plugin-b");
  });

  it("✗ dependsOn cycle is loud and suppresses the members' ✓ rows", () => {
    declare({ "plugin-a": {}, "plugin-b": {} });
    install("plugin-a", { namespace: "a", dependsOn: [{ plugin: "plugin-b", version: "*" }] });
    install("plugin-b", { namespace: "b", dependsOn: [{ plugin: "plugin-a", version: "*" }] });
    writeLockFile({ "plugin-a": pinFor("plugin-a"), "plugin-b": pinFor("plugin-b") });
    const checks = run();
    const row = find(checks, /dependency cycle:/);
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/server start ABORTS/);
    expect(row?.fix).toMatch(/remove one direction/);
    expect(find(checks, /plugin-a@1\.0\.0/)).toBeUndefined();
    expect(find(checks, /plugin-b@1\.0\.0/)).toBeUndefined();
  });
});

describe("doctor exit-code convention", () => {
  it("informational − rows report ok=true so they never fail doctor", () => {
    declare({ "plugin-off": { enabled: false } });
    writeLockFile({});
    const checks = run();
    for (const c of checks.filter((x) => x.info)) expect(c.ok).toBe(true);
    expect(fails(checks)).toHaveLength(0);
  });

  it("any plugins ✗ row reports ok=false (fails doctor overall)", () => {
    declare({ "plugin-missing": {} });
    const checks = run();
    expect(fails(checks).length).toBeGreaterThan(0);
    for (const c of fails(checks)) expect(c.fix).toBeTruthy();
  });
});
