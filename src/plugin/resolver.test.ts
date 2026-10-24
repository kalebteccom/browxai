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

  it("is community for an @browxai/ name with no lock entry", () => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, NAME);
    expect(tierOf(paths)).toBe("community");
  });

  it("is community for an aliased install", () => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, NAME);
    writeLockEntry(paths, NAME, `${NAME}@npm:other`, "sha512-AAAA");
    expect(tierOf(paths)).toBe("community");
  });

  it("is community for a git install whose package.json claims the name", () => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, NAME, { trust: "kalebtec" });
    writeLockEntry(paths, NAME, "github:someone/repo", "sha512-AAAA");
    expect(tierOf(paths)).toBe("community");
  });

  it("is community for a plain registry spec without an integrity hash", () => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, NAME);
    writeLockEntry(paths, NAME, NAME);
    expect(tierOf(paths)).toBe("community");
  });

  it("is community when the installed package.json names another package", () => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, NAME, {}, "other");
    writeLockEntry(paths, NAME, NAME, "sha512-AAAA");
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

describe("resolveDeclaredPlugin entry containment", () => {
  it("refuses a register path that leaves the package with ../", () => {
    const paths = pluginPaths(workspaceRoot);
    installPackage(paths, "outside-rel", { register: "../x.js" });
    writeFileSync(join(paths.nodeModulesDir, "x.js"), "export function register(){}");
    const r = resolveDeclaredPlugin(paths, { name: "outside-rel", enabled: true });
    expect(r.kind).toBe("invalid-manifest");
    if (r.kind === "invalid-manifest") expect(r.error).toMatch(/outside the package directory/);
  });

  it("refuses an absolute register path", () => {
    const paths = pluginPaths(workspaceRoot);
    const outsideFile = join(workspaceRoot, "outside.js");
    writeFileSync(outsideFile, "export function register(){}");
    installPackage(paths, "outside-abs", { register: outsideFile });
    const r = resolveDeclaredPlugin(paths, { name: "outside-abs", enabled: true });
    expect(r.kind).toBe("invalid-manifest");
    if (r.kind === "invalid-manifest") expect(r.error).toMatch(/absolute path/);
  });

  it("refuses a register path that leaves the package through a symlink", () => {
    const paths = pluginPaths(workspaceRoot);
    const outsideDir = join(workspaceRoot, "elsewhere");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "index.js"), "export function register(){}");
    const pkgRoot = installPackage(paths, "outside-link", { register: "lib/index.js" });
    symlinkSync(outsideDir, join(pkgRoot, "lib"));
    const r = resolveDeclaredPlugin(paths, { name: "outside-link", enabled: true });
    expect(r.kind).toBe("invalid-manifest");
    if (r.kind === "invalid-manifest") expect(r.error).toMatch(/through a link/);
  });

  it("accepts an entry in a subdirectory of the package", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = installPackage(paths, "nested", { register: "dist/index.js" });
    mkdirSync(join(pkgRoot, "dist"));
    writeFileSync(join(pkgRoot, "dist", "index.js"), "export function register(){}");
    expect(resolveDeclaredPlugin(paths, { name: "nested", enabled: true }).kind).toBe("resolved");
  });
});

describe("resolveDeclaredPlugin", () => {
  it("returns not-installed when the package dir is absent", () => {
    const paths = pluginPaths(workspaceRoot);
    const r = resolveDeclaredPlugin(paths, { name: "missing", enabled: true });
    expect(r.kind).toBe("not-installed");
  });

  it("returns invalid-manifest when package.json lacks browxai field", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = join(paths.nodeModulesDir, "plain");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "plain", version: "1.0.0" }),
    );
    const r = resolveDeclaredPlugin(paths, { name: "plain", enabled: true });
    expect(r.kind).toBe("invalid-manifest");
  });

  it("resolves a registry-installed @browxai/ plugin with an integrity pin as kalebtec", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = join(paths.nodeModulesDir, "@browxai", "plugin-good");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "@browxai/plugin-good",
        version: "1.2.3",
        browxai: { apiVersion: "1.0.0", namespace: "good", register: "index.js" },
      }),
    );
    writeFileSync(join(pkgRoot, "index.js"), "export function register(){}");
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

  it("honours per-entry trust override from plugins.json", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = join(paths.nodeModulesDir, "@browxai", "plugin-good");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "@browxai/plugin-good",
        version: "1.2.3",
        browxai: { apiVersion: "1.0.0", namespace: "good", register: "index.js" },
      }),
    );
    writeFileSync(join(pkgRoot, "index.js"), "export function register(){}");
    const r = resolveDeclaredPlugin(paths, {
      name: "@browxai/plugin-good",
      enabled: true,
      trust: "local",
    });
    if (r.kind !== "resolved") throw new Error("expected resolved");
    expect(r.manifest.trust).toBe("local");
  });

  it("refuses a self-declared kalebtec tier outside the @browxai/* scope", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = join(paths.nodeModulesDir, "browxai-plugin-hostile");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "browxai-plugin-hostile",
        version: "1.0.0",
        browxai: {
          apiVersion: "1.0.0",
          namespace: "hostile",
          register: "index.js",
          trust: "kalebtec",
        },
      }),
    );
    writeFileSync(join(pkgRoot, "index.js"), "export function register(){}");
    const r = resolveDeclaredPlugin(paths, { name: "browxai-plugin-hostile", enabled: true });
    if (r.kind !== "resolved") throw new Error("expected resolved");
    expect(r.manifest.trust).toBe("community");
  });

  it("honours a manifest self-downgrade below what the scope would grant", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = join(paths.nodeModulesDir, "@browxai", "plugin-modest");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "@browxai/plugin-modest",
        version: "1.0.0",
        browxai: {
          apiVersion: "1.0.0",
          namespace: "modest",
          register: "index.js",
          trust: "community",
        },
      }),
    );
    writeFileSync(join(pkgRoot, "index.js"), "export function register(){}");
    const r = resolveDeclaredPlugin(paths, { name: "@browxai/plugin-modest", enabled: true });
    if (r.kind !== "resolved") throw new Error("expected resolved");
    expect(r.manifest.trust).toBe("community");
  });

  it("rejects when register entry file is missing", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = join(paths.nodeModulesDir, "noentry");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "noentry",
        version: "1.0.0",
        browxai: { apiVersion: "1.0.0", namespace: "x", register: "missing.js" },
      }),
    );
    const r = resolveDeclaredPlugin(paths, { name: "noentry", enabled: true });
    expect(r.kind).toBe("invalid-manifest");
    if (r.kind === "invalid-manifest") {
      expect(r.error).toMatch(/does not exist/);
    }
  });
});
