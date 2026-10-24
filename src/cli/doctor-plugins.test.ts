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

  it("✗ when plugins.json is malformed JSON, with a fix pointing at the file", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "plugins.json"), "{not json");
    const checks = run();
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/plugins\.json malformed/);
    expect(checks[0]!.fix).toContain(join(root, "plugins.json"));
  });
});

describe("declared-plugin drift", () => {
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

interface FailRow {
  label: string;
  setup: () => void;
  /** Every pattern must match the failing row's detail. */
  detail: RegExp[];
  /** A string must be contained in the fix hint, a RegExp must match it. */
  fix: Array<string | RegExp>;
  extra?: (checks: Check[]) => void;
}

const SYNC = "browxai plugin sync";

const FAIL_ROWS: FailRow[] = [
  {
    label: "declared but not installed points at plugin sync",
    setup: () => declare({ "plugin-missing": {} }),
    detail: [/plugin-missing declared but not installed/],
    fix: [SYNC],
  },
  {
    label: "installed-but-not-declared plugin is an orphan to remove or declare",
    setup: () => {
      declare({ "plugin-good": {} });
      install("plugin-good", { namespace: "good" });
      writeLockFile({ "plugin-good": pinFor("plugin-good") });
      install("@scope/plugin-orphan", { namespace: "orphan" });
    },
    detail: [/orphan install: @scope\/plugin-orphan/],
    fix: ["browxai plugin remove @scope/plugin-orphan", /declare it/],
  },
  {
    label: "plugins-lock.json missing while plugins are declared",
    setup: () => {
      declare({ "plugin-good": {} });
      install("plugin-good", { namespace: "good" });
    },
    detail: [/plugins-lock\.json missing/],
    fix: [SYNC],
  },
  {
    label: "sha256 mismatch vs the installed package is loud and fail-closed",
    setup: () => {
      declare({ "plugin-good": {} });
      install("plugin-good", { namespace: "good" });
      writeLockFile({ "plugin-good": pinFor("plugin-good", { contentSha256: "deadbeef" }) });
    },
    detail: [/contentSha256 MISMATCH/, /NOT what was pinned/],
    fix: [/do not trust the install until audited/, SYNC],
  },
  {
    label: "installed and declared plugin missing its lock pin",
    setup: () => {
      declare({ "plugin-good": {} });
      install("plugin-good", { namespace: "good" });
      writeLockFile({});
    },
    detail: [/no pin in plugins-lock\.json/],
    fix: [SYNC],
  },
  {
    label: "stale lock entry for an undeclared plugin",
    setup: () => {
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
    },
    detail: [/stale lock entry: plugin-ghost/],
    fix: ["browxai plugin remove plugin-ghost"],
  },
  {
    label: "invalid manifest (package.json lacks the browxai field)",
    setup: () => {
      declare({ "plugin-plain": {} });
      install("plugin-plain", { browxai: false });
    },
    detail: [/plugin-plain invalid manifest/],
    fix: ["package.json#browxai"],
  },
  {
    label: "apiVersion incompatible with RUNTIME_API_VERSION",
    setup: () => {
      declare({ "plugin-future": {} });
      install("plugin-future", { namespace: "future", apiVersion: "2.0.0" });
      writeLockFile({ "plugin-future": pinFor("plugin-future") });
    },
    detail: [/apiVersion "2\.0\.0" incompatible with runtime apiVersion "1\.0\.0"/],
    fix: [/upgrade the plugin/],
  },
  {
    label: "duplicate namespace across the declared set names both plugins",
    setup: () => {
      declare({ "plugin-a": {}, "plugin-b": {} });
      install("plugin-a", { namespace: "shared" });
      install("plugin-b", { namespace: "shared" });
      writeLockFile({ "plugin-a": pinFor("plugin-a"), "plugin-b": pinFor("plugin-b") });
    },
    detail: [/plugin-b namespace "shared" already claimed by plugin-a/],
    fix: [/rename one/],
    // First claimer stays healthy.
    extra: (checks) => expect(find(checks, /plugin-a@1\.0\.0/)?.ok).toBe(true),
  },
  {
    label: "capability mismatch names the missing capability in the fix hint",
    setup: () => {
      declare({ "plugin-canvas": {} });
      install("plugin-canvas", { namespace: "cv", capabilities: ["eval", "canvas"] });
      writeLockFile({ "plugin-canvas": pinFor("plugin-canvas") });
    },
    detail: [/capability\(ies\) \[eval, canvas\] not enabled/],
    fix: ["set BROWX_CAPABILITIES=read,navigation,action,human,eval,canvas", /restart/],
  },
  {
    label: "dependsOn target not resolvable",
    setup: () => {
      declare({ "plugin-a": {} });
      install("plugin-a", {
        namespace: "a",
        dependsOn: [{ plugin: "plugin-b", version: "^1.0.0" }],
      });
      writeLockFile({ "plugin-a": pinFor("plugin-a") });
    },
    detail: [/dependsOn\["plugin-b"\] is not resolvable/],
    fix: ["browxai plugin install plugin-b"],
  },
  {
    label: "dependsOn version range unsatisfied",
    setup: () => {
      declare({ "plugin-a": {}, "plugin-b": {} });
      install("plugin-a", {
        namespace: "a",
        dependsOn: [{ plugin: "plugin-b", version: "^2.0.0" }],
      });
      install("plugin-b", { namespace: "b", version: "1.0.0" });
      writeLockFile({ "plugin-a": pinFor("plugin-a"), "plugin-b": pinFor("plugin-b") });
    },
    detail: [/installed version 1\.0\.0 does not satisfy range "\^2\.0\.0"/],
    fix: ["browxai plugin upgrade plugin-b"],
  },
  {
    label: "dependsOn cycle is loud and suppresses the members' healthy rows",
    setup: () => {
      declare({ "plugin-a": {}, "plugin-b": {} });
      install("plugin-a", { namespace: "a", dependsOn: [{ plugin: "plugin-b", version: "*" }] });
      install("plugin-b", { namespace: "b", dependsOn: [{ plugin: "plugin-a", version: "*" }] });
      writeLockFile({ "plugin-a": pinFor("plugin-a"), "plugin-b": pinFor("plugin-b") });
    },
    detail: [/dependency cycle:/, /server start ABORTS/],
    fix: [/remove one direction/],
    extra: (checks) => {
      expect(find(checks, /plugin-a@1\.0\.0/)).toBeUndefined();
      expect(find(checks, /plugin-b@1\.0\.0/)).toBeUndefined();
    },
  },
];

describe("failing doctor rows", () => {
  it.each(FAIL_ROWS)("✗ $label", ({ setup, detail, fix, extra }) => {
    setup();
    const checks = run();
    const row = find(checks, detail[0]!);
    expect(row?.ok).toBe(false);
    for (const re of detail) expect(row?.detail).toMatch(re);
    for (const f of fix) {
      if (typeof f === "string") expect(row?.fix).toContain(f);
      else expect(row?.fix).toMatch(f);
    }
    extra?.(checks);
  });
});
