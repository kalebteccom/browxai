import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  newExtensionRegistry,
  resolveExtensionPath,
  readManifest,
  extensionIdFromPath,
  buildLaunchArgs,
  refuseIfUnsupported,
  applyInstall,
  applyUninstall,
  applyReload,
  type LoadedExtension,
} from "./extensions.js";

// --- fixture helpers -------------------------------------------------------

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "browxai-ext-"));
}

function makeExtensionDir(workspace: string, rel: string, manifest: Record<string, unknown>): string {
  const dir = join(workspace, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

let workspace: string;

beforeEach(() => {
  workspace = makeWorkspace();
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// --- resolveExtensionPath --------------------------------------------------

describe("resolveExtensionPath", () => {
  it("resolves a workspace-rooted extension directory", () => {
    const ext = makeExtensionDir(workspace, "ext/foo", { name: "foo", version: "0.0.1", manifest_version: 3 });
    expect(resolveExtensionPath(workspace, "ext/foo", "extensions_install")).toBe(ext);
  });

  it("rejects path traversal that escapes the workspace", () => {
    expect(() => resolveExtensionPath(workspace, "../escape", "extensions_install")).toThrow(/must resolve inside/);
  });

  it("rejects absolute paths pointing outside the workspace", () => {
    expect(() => resolveExtensionPath(workspace, "/etc", "extensions_install")).toThrow(/must resolve inside/);
  });

  it("rejects empty / whitespace path", () => {
    expect(() => resolveExtensionPath(workspace, "", "extensions_install")).toThrow(/required/);
    expect(() => resolveExtensionPath(workspace, "   ", "extensions_install")).toThrow(/required/);
  });

  it("rejects a non-existent directory", () => {
    expect(() => resolveExtensionPath(workspace, "ext/missing", "extensions_install")).toThrow(/not found/);
  });

  it("rejects a file (not a directory)", () => {
    writeFileSync(join(workspace, "not-a-dir.crx"), "binary", "utf8");
    expect(() => resolveExtensionPath(workspace, "not-a-dir.crx", "extensions_install")).toThrow(/not a directory/);
  });

  it("rejects a directory missing manifest.json", () => {
    mkdirSync(join(workspace, "no-manifest"), { recursive: true });
    expect(() => resolveExtensionPath(workspace, "no-manifest", "extensions_install")).toThrow(/no manifest\.json/);
  });

  it("accepts an absolute path that is INSIDE the workspace", () => {
    const ext = makeExtensionDir(workspace, "ext/inside", { name: "inside", version: "1.0.0", manifest_version: 3 });
    expect(resolveExtensionPath(workspace, ext, "extensions_install")).toBe(ext);
  });
});

// --- readManifest ----------------------------------------------------------

describe("readManifest", () => {
  it("parses name/version/manifest_version", () => {
    const ext = makeExtensionDir(workspace, "ext/m", { name: "My Ext", version: "1.2.3", manifest_version: 3 });
    expect(readManifest(ext, "extensions_install")).toEqual({ name: "My Ext", version: "1.2.3", manifestVersion: 3 });
  });

  it("falls back to defaults for missing/wrong-typed fields", () => {
    const ext = makeExtensionDir(workspace, "ext/m", { foo: "bar" });
    expect(readManifest(ext, "extensions_install")).toEqual({ name: "(unnamed)", version: "0.0.0", manifestVersion: 0 });
  });

  it("throws on non-JSON manifest", () => {
    const ext = join(workspace, "ext/bad");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "manifest.json"), "not json", "utf8");
    expect(() => readManifest(ext, "extensions_install")).toThrow(/not valid JSON/);
  });

  it("throws on a non-object manifest (array)", () => {
    const ext = join(workspace, "ext/arr");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "manifest.json"), "[]", "utf8");
    expect(() => readManifest(ext, "extensions_install")).toThrow(/must be a JSON object/);
  });
});

// --- extensionIdFromPath ---------------------------------------------------

describe("extensionIdFromPath", () => {
  it("returns a 32-char lowercase a-p string", () => {
    const id = extensionIdFromPath("/some/path");
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it("is deterministic for the same path", () => {
    expect(extensionIdFromPath("/x/y")).toBe(extensionIdFromPath("/x/y"));
  });

  it("differs across distinct paths", () => {
    expect(extensionIdFromPath("/x/y")).not.toBe(extensionIdFromPath("/x/z"));
  });
});

// --- buildLaunchArgs -------------------------------------------------------

describe("buildLaunchArgs", () => {
  const mk = (path: string, enabled = true): LoadedExtension =>
    ({ id: extensionIdFromPath(path), name: "n", version: "0", path, enabled });

  it("returns empty args for an empty list", () => {
    expect(buildLaunchArgs([])).toEqual([]);
  });

  it("emits both --disable-extensions-except and --load-extension flags", () => {
    const args = buildLaunchArgs([mk("/a/ext1"), mk("/b/ext2")]);
    expect(args).toEqual([
      "--disable-extensions-except=/a/ext1,/b/ext2",
      "--load-extension=/a/ext1,/b/ext2",
    ]);
  });

  it("skips disabled extensions", () => {
    const args = buildLaunchArgs([mk("/a", true), mk("/b", false), mk("/c", true)]);
    expect(args).toEqual([
      "--disable-extensions-except=/a,/c",
      "--load-extension=/a,/c",
    ]);
  });
});

// --- refuseIfUnsupported ---------------------------------------------------

describe("refuseIfUnsupported", () => {
  it("refuses attached/BYOB sessions", () => {
    const r = refuseIfUnsupported({ mode: "attached", headless: false, tool: "extensions_install" });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/attached\/BYOB sessions/);
    expect(r?.hint).toMatch(/not-owned/);
  });

  it("refuses incognito sessions", () => {
    const r = refuseIfUnsupported({ mode: "incognito", headless: false, tool: "extensions_install" });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/incognito/);
    expect(r?.hint).toMatch(/allowed in incognito/);
  });

  it("refuses headless persistent sessions", () => {
    const r = refuseIfUnsupported({ mode: "persistent", headless: true, tool: "extensions_install" });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/headed session/);
  });

  it("returns null for headed persistent sessions", () => {
    expect(refuseIfUnsupported({ mode: "persistent", headless: false, tool: "extensions_install" })).toBeNull();
  });
});

// --- applyInstall / applyUninstall / applyReload --------------------------

describe("applyInstall", () => {
  it("appends a new extension and returns its id", () => {
    const reg = newExtensionRegistry();
    const r = applyInstall(reg, { path: "/p/a", name: "A", version: "1.0" }, "extensions_install");
    expect(r.id).toMatch(/^[a-p]{32}$/);
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0]).toMatchObject({ id: r.id, name: "A", version: "1.0", path: "/p/a", enabled: true });
  });

  it("rejects a duplicate path", () => {
    const path = `${sep}p${sep}a`;
    const reg: ReturnType<typeof newExtensionRegistry> = {
      loaded: [{ id: extensionIdFromPath(path), name: "A", version: "1.0", path, enabled: true }],
    };
    expect(() => applyInstall(reg, { path, name: "A", version: "1.0" }, "extensions_install")).toThrow(/already loaded/);
  });
});

describe("applyUninstall", () => {
  it("removes an extension by id", () => {
    const path = "/p/a";
    const reg: ReturnType<typeof newExtensionRegistry> = {
      loaded: [{ id: extensionIdFromPath(path), name: "A", version: "1.0", path, enabled: true }],
    };
    const r = applyUninstall(reg, extensionIdFromPath(path), "extensions_uninstall");
    expect(r.loaded).toHaveLength(0);
    expect(r.removed.path).toBe(path);
  });

  it("throws when the id is unknown", () => {
    expect(() => applyUninstall(newExtensionRegistry(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "extensions_uninstall")).toThrow(/no extension with id/);
  });
});

describe("applyReload", () => {
  it("updates name + version from a re-parsed manifest", () => {
    const path = "/p/a";
    const id = extensionIdFromPath(path);
    const reg: ReturnType<typeof newExtensionRegistry> = {
      loaded: [{ id, name: "A", version: "1.0", path, enabled: true }],
    };
    const r = applyReload(reg, id, { name: "A2", version: "2.0", manifestVersion: 3 }, "extensions_reload");
    expect(r.entry).toMatchObject({ id, name: "A2", version: "2.0" });
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0]?.name).toBe("A2");
  });

  it("throws when the id is unknown", () => {
    expect(() => applyReload(newExtensionRegistry(), "x".repeat(32), { name: "n", version: "0", manifestVersion: 3 }, "extensions_reload")).toThrow(/no extension with id/);
  });
});
