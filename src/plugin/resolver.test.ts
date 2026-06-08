// Manifest resolver — `plugins.json` parsing + per-plugin manifest
// resolution from disk.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginPaths, readDeclaration, resolveDeclaredPlugin } from "./resolver.js";

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "browxai-resolver-test-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("readDeclaration", () => {
  it("returns [] when plugins.json is missing", () => {
    const paths = pluginPaths(workspaceRoot);
    expect(readDeclaration(paths)).toEqual([]);
  });

  it("returns [] on malformed JSON, with no throw", () => {
    const paths = pluginPaths(workspaceRoot);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.declarationFile, "{not valid");
    expect(readDeclaration(paths)).toEqual([]);
  });

  it("parses array form", () => {
    const paths = pluginPaths(workspaceRoot);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.declarationFile, JSON.stringify({ plugins: ["a", "b"] }));
    const d = readDeclaration(paths);
    expect(d.map((p) => p.name)).toEqual(["a", "b"]);
    expect(d.every((p) => p.enabled)).toBe(true);
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

  it("resolves a well-formed plugin and reports kalebtec trust for @kalebtec/", () => {
    const paths = pluginPaths(workspaceRoot);
    const pkgRoot = join(paths.nodeModulesDir, "@kalebtec", "browxai-plugin-good");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "@kalebtec/browxai-plugin-good",
        version: "1.2.3",
        browxai: { apiVersion: "1.0.0", namespace: "good", register: "index.js" },
      }),
    );
    writeFileSync(join(pkgRoot, "index.js"), "export function register(){}");
    const r = resolveDeclaredPlugin(paths, {
      name: "@kalebtec/browxai-plugin-good",
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
    const pkgRoot = join(paths.nodeModulesDir, "@kalebtec", "browxai-plugin-good");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: "@kalebtec/browxai-plugin-good",
        version: "1.2.3",
        browxai: { apiVersion: "1.0.0", namespace: "good", register: "index.js" },
      }),
    );
    writeFileSync(join(pkgRoot, "index.js"), "export function register(){}");
    const r = resolveDeclaredPlugin(paths, {
      name: "@kalebtec/browxai-plugin-good",
      enabled: true,
      trust: "local",
    });
    if (r.kind !== "resolved") throw new Error("expected resolved");
    expect(r.manifest.trust).toBe("local");
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
