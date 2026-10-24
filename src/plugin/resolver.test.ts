// Manifest resolver — `plugins.json` parsing + per-plugin manifest
// resolution from disk.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pluginPaths,
  readDeclaration,
  resolveDeclaredPlugin,
  type PluginPaths,
} from "./resolver.js";

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "browxai-resolver-test-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("readDeclaration", () => {
  it("returns [] on malformed JSON, with no throw", () => {
    const paths = pluginPaths(workspaceRoot);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.declarationFile, "{not valid");
    expect(readDeclaration(paths)).toEqual([]);
  });

  it("parses object form with trust + enabled flags", () => {
    const paths = pluginPaths(workspaceRoot);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      paths.declarationFile,
      JSON.stringify({
        plugins: {
          a: { enabled: true, trust: "local" },
          b: { enabled: false },
        },
      }),
    );
    const d = readDeclaration(paths);
    expect(d.find((p) => p.name === "a")?.trust).toBe("local");
    expect(d.find((p) => p.name === "b")?.enabled).toBe(false);
  });
});

function writeLockEntry(
  paths: PluginPaths,
  name: string,
  source: string,
  integrity?: string,
): void {
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(
    paths.lockFile,
    JSON.stringify({
      lockfileVersion: 1,
      entries: {
        [name]: {
          name,
          version: "1.2.3",
          source,
          contentSha256: "x",
          ...(integrity ? { integrity } : {}),
        },
      },
    }),
  );
}

/** Lay out a plugin package under node_modules; returns its root. `pkgName`
 *  is the `name` its package.json declares. */
function installPackage(
  paths: PluginPaths,
  name: string,
  browxai: Record<string, unknown> = {},
  pkgName: string = name,
): string {
  const pkgRoot = join(paths.nodeModulesDir, ...name.split("/"));
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(
    join(pkgRoot, "package.json"),
    JSON.stringify({
      name: pkgName,
      version: "1.2.3",
      browxai: { apiVersion: "1.0.0", namespace: "p", register: "index.js", ...browxai },
    }),
  );
  writeFileSync(join(pkgRoot, "index.js"), "export function register(){}");
  return pkgRoot;
}

describe("resolveDeclaredPlugin first-party tier", () => {
  const NAME = "@browxai/plugin-good";
  const tierOf = (paths: PluginPaths, trust?: "kalebtec"): string | undefined => {
    const r = resolveDeclaredPlugin(paths, {
      name: NAME,
      enabled: true,
      ...(trust ? { trust } : {}),
    });
    return r.kind === "resolved" ? r.manifest.trust : undefined;
  };

  it.each([
    { label: "an @browxai/ name with no lock entry" },
    { label: "an aliased install", lockSource: `${NAME}@npm:other`, integrity: "sha512-AAAA" },
    {
      label: "a git install whose package.json claims the name",
      browxai: { trust: "kalebtec" },
      lockSource: "github:someone/repo",
      integrity: "sha512-AAAA",
    },
    { label: "a plain registry spec without an integrity hash", lockSource: NAME },
    {
      label: "an installed package.json that names another package",
      pkgName: "other",
      lockSource: NAME,
      integrity: "sha512-AAAA",
    },
  ])("is community for $label", ({ browxai, pkgName, lockSource, integrity }) => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, NAME, browxai ?? {}, pkgName ?? NAME);
    if (lockSource) writeLockEntry(paths, NAME, lockSource, integrity);
    expect(tierOf(paths)).toBe("community");
  });

  it("drops a plugins.json kalebtec override the install does not support", () => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, NAME);
    expect(tierOf(paths, "kalebtec")).toBe("community");
    writeLockEntry(paths, NAME, NAME, "sha512-AAAA");
    expect(tierOf(paths, "kalebtec")).toBe("kalebtec");
  });
});

describe("resolveDeclaredPlugin", () => {
  it("accepts an entry in a subdirectory of the package", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = installPackage(paths, "nested", { register: "dist/index.js" });
    mkdirSync(join(pkgRoot, "dist"));
    writeFileSync(join(pkgRoot, "dist", "index.js"), "export function register(){}");
    expect(resolveDeclaredPlugin(paths, { name: "nested", enabled: true }).kind).toBe("resolved");
  });

  it.each<{
    label: string;
    name: string;
    kind: string;
    error?: RegExp;
    setup: (paths: PluginPaths) => void;
  }>([
    {
      label: "a register path that leaves the package with ../",
      name: "outside-rel",
      kind: "invalid-manifest",
      error: /outside the package directory/,
      setup: (paths) => {
        installPackage(paths, "outside-rel", { register: "../x.js" });
        writeFileSync(join(paths.nodeModulesDir, "x.js"), "export function register(){}");
      },
    },
    {
      label: "an absolute register path",
      name: "outside-abs",
      kind: "invalid-manifest",
      error: /absolute path/,
      setup: (paths) => {
        const outsideFile = join(workspaceRoot, "outside.js");
        writeFileSync(outsideFile, "export function register(){}");
        installPackage(paths, "outside-abs", { register: outsideFile });
      },
    },
    {
      label: "a register path that leaves the package through a symlink",
      name: "outside-link",
      kind: "invalid-manifest",
      error: /through a link/,
      setup: (paths) => {
        const outsideDir = join(workspaceRoot, "elsewhere");
        mkdirSync(outsideDir);
        writeFileSync(join(outsideDir, "index.js"), "export function register(){}");
        const pkgRoot = installPackage(paths, "outside-link", { register: "lib/index.js" });
        symlinkSync(outsideDir, join(pkgRoot, "lib"));
      },
    },
    {
      label: "a register entry file that is missing",
      name: "noentry",
      kind: "invalid-manifest",
      error: /does not exist/,
      setup: (paths) => {
        installPackage(paths, "noentry", { namespace: "x", register: "missing.js" });
        rmSync(join(paths.nodeModulesDir, "noentry", "index.js"));
      },
    },
    {
      label: "a package.json without a browxai field",
      name: "plain",
      kind: "invalid-manifest",
      setup: (paths) => {
        const pkgRoot = join(paths.nodeModulesDir, "plain");
        mkdirSync(pkgRoot, { recursive: true });
        writeFileSync(
          join(pkgRoot, "package.json"),
          JSON.stringify({ name: "plain", version: "1.0.0" }),
        );
      },
    },
    {
      label: "a package dir that is absent",
      name: "missing",
      kind: "not-installed",
      setup: () => {},
    },
  ])("refuses $label", ({ name, kind, error, setup }) => {
    const paths = pluginPaths(workspaceRoot);
    setup(paths);
    const r = resolveDeclaredPlugin(paths, { name, enabled: true });
    expect(r.kind).toBe(kind);
    if (error && r.kind === "invalid-manifest") expect(r.error).toMatch(error);
  });

  it("resolves a registry-installed @browxai/ plugin with an integrity pin as kalebtec", () => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, "@browxai/plugin-good", { namespace: "good" });
    writeLockEntry(paths, "@browxai/plugin-good", "@browxai/plugin-good@^1.2.0", "sha512-AAAA");
    const r = resolveDeclaredPlugin(paths, {
      name: "@browxai/plugin-good",
      enabled: true,
    });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.manifest.trust).toBe("kalebtec");
      expect(r.manifest.version).toBe("1.2.3");
      expect(r.manifest.browxai.namespace).toBe("good");
    }
  });

  it.each<{
    label: string;
    name: string;
    browxai: Record<string, unknown>;
    entryTrust?: "local";
    expected: string;
  }>([
    {
      label: "honours a per-entry trust override from plugins.json",
      name: "@browxai/plugin-good",
      browxai: { namespace: "good" },
      entryTrust: "local",
      expected: "local",
    },
    {
      label: "refuses a self-declared kalebtec tier outside the @browxai/* scope",
      name: "browxai-plugin-hostile",
      browxai: { namespace: "hostile", trust: "kalebtec" },
      expected: "community",
    },
    {
      label: "honours a manifest self-downgrade below what the scope would grant",
      name: "@browxai/plugin-modest",
      browxai: { namespace: "modest", trust: "community" },
      expected: "community",
    },
  ])("$label", ({ name, browxai, entryTrust, expected }) => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, name, browxai);
    const r = resolveDeclaredPlugin(paths, {
      name,
      enabled: true,
      ...(entryTrust ? { trust: entryTrust } : {}),
    });
    if (r.kind !== "resolved") throw new Error("expected resolved");
    expect(r.manifest.trust).toBe(expected);
  });
});
