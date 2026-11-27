import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  newExtensionRegistry,
  resolveExtensionPath,
  operatorExtensionsDir,
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

function makeExtensionDir(
  workspace: string,
  rel: string,
  manifest: Record<string, unknown>,
): string {
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
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// --- resolveExtensionPath --------------------------------------------------

describe("resolveExtensionPath", () => {
  const noEnv = {};

  it.each([
    {
      label: "a path that escapes the workspace",
      inputs: ["../escape"],
      message: /load only from/,
    },
    { label: "an empty or whitespace path", inputs: ["", "   "], message: /required/ },
    { label: "a non-existent directory", inputs: ["extensions/missing"], message: /not found/ },
    {
      label: "a file (not a directory)",
      inputs: ["extensions/not-a-dir.crx"],
      setup: () => {
        mkdirSync(join(workspace, "extensions"), { recursive: true });
        writeFileSync(join(workspace, "extensions/not-a-dir.crx"), "binary", "utf8");
      },
      message: /not a directory/,
    },
    {
      label: "a directory missing manifest.json",
      inputs: ["extensions/no-manifest"],
      setup: () => mkdirSync(join(workspace, "extensions/no-manifest"), { recursive: true }),
      message: /no manifest\.json/,
    },
  ] as Array<{ label: string; inputs: string[]; setup?: () => void; message: RegExp }>)(
    "rejects $label",
    ({ inputs, setup, message }) => {
      setup?.();
      for (const input of inputs) {
        expect(() => resolveExtensionPath(workspace, input, "extensions_install", noEnv)).toThrow(
          message,
        );
      }
    },
  );

  it("accepts a relative or absolute path under the workspace extensions/ directory", () => {
    const ext = makeExtensionDir(workspace, "extensions/inside", {
      name: "inside",
      version: "1.0.0",
      manifest_version: 3,
    });
    expect(resolveExtensionPath(workspace, ext, "extensions_install", noEnv)).toBe(ext);
    expect(resolveExtensionPath(workspace, "extensions/inside", "extensions_install", noEnv)).toBe(
      ext,
    );
  });

  // Only `extensions/` is a staging directory. A directory a tool writes into,
  // or any other workspace directory, is refused even with a valid manifest.
  it.each([".artifacts/s1/ext", ".downloads/s1/ext", "archives/ext", "assets/ext", "ext/inside"])(
    "rejects %s, outside extensions/",
    (rel) => {
      const dir = makeExtensionDir(workspace, rel, {
        name: "x",
        version: "1.0.0",
        manifest_version: 3,
      });
      for (const input of [rel, dir]) {
        expect(() => resolveExtensionPath(workspace, input, "extensions_install", noEnv)).toThrow(
          /load only from the workspace extensions\/ directory/,
        );
      }
    },
  );

  it("rejects a directory whose name only starts like extensions/", () => {
    makeExtensionDir(workspace, "extensions-mine/ext", {
      name: "x",
      version: "1.0.0",
      manifest_version: 3,
    });
    expect(() =>
      resolveExtensionPath(workspace, "extensions-mine/ext", "extensions_install", noEnv),
    ).toThrow(/load only from/);
  });

  it("rejects a link under extensions/ that points into a tool output directory", () => {
    const target = makeExtensionDir(workspace, ".downloads/s1/ext", {
      name: "x",
      version: "1.0.0",
      manifest_version: 3,
    });
    mkdirSync(join(workspace, "extensions"), { recursive: true });
    symlinkSync(target, join(workspace, "extensions", "linked"));
    expect(() =>
      resolveExtensionPath(workspace, "extensions/linked", "extensions_install", noEnv),
    ).toThrow(/load only from/);
  });

  describe("BROWX_EXTENSIONS_DIR", () => {
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "browxai-ext-operator-"));
    });
    afterEach(() => rmSync(outside, { recursive: true, force: true }));

    it("accepts an extension under the operator directory, outside the workspace", () => {
      const ext = makeExtensionDir(outside, "helper", {
        name: "helper",
        version: "1.0.0",
        manifest_version: 3,
      });
      const env = { BROWX_EXTENSIONS_DIR: outside };
      expect(resolveExtensionPath(workspace, ext, "extensions_install", env)).toBe(ext);
    });

    it("still accepts the workspace extensions/ directory", () => {
      const ext = makeExtensionDir(workspace, "extensions/inside", {
        name: "inside",
        version: "1.0.0",
        manifest_version: 3,
      });
      const env = { BROWX_EXTENSIONS_DIR: outside };
      expect(resolveExtensionPath(workspace, "extensions/inside", "extensions_install", env)).toBe(
        ext,
      );
    });

    it("rejects a path outside both directories", () => {
      const other = mkdtempSync(join(tmpdir(), "browxai-ext-other-"));
      try {
        const ext = makeExtensionDir(other, "x", { name: "x", version: "1", manifest_version: 3 });
        const env = { BROWX_EXTENSIONS_DIR: outside };
        expect(() => resolveExtensionPath(workspace, ext, "extensions_install", env)).toThrow(
          /or BROWX_EXTENSIONS_DIR/,
        );
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it.each([
      ["a relative path", () => "relative/dir", /must be an absolute path/],
      ["a directory inside the workspace", () => join(workspace, "downloads"), /overlaps/],
      ["a parent of the workspace", () => join(workspace, ".."), /overlaps/],
    ] as Array<[string, () => string, RegExp]>)("refuses %s", (_label, dir, message) => {
      const ext = makeExtensionDir(workspace, "extensions/inside", {
        name: "inside",
        version: "1.0.0",
        manifest_version: 3,
      });
      expect(() =>
        operatorExtensionsDir(workspace, "extensions_install", { BROWX_EXTENSIONS_DIR: dir() }),
      ).toThrow(message);
      expect(() =>
        resolveExtensionPath(workspace, ext, "extensions_install", {
          BROWX_EXTENSIONS_DIR: dir(),
        }),
      ).toThrow(message);
    });
  });
});

// --- readManifest ----------------------------------------------------------

describe("readManifest", () => {
  it.each([
    {
      label: "parses name/version/manifest_version",
      manifest: { name: "My Ext", version: "1.2.3", manifest_version: 3 },
      expected: { name: "My Ext", version: "1.2.3", manifestVersion: 3 },
    },
    {
      label: "falls back to defaults for missing/wrong-typed fields",
      manifest: { foo: "bar" },
      expected: { name: "(unnamed)", version: "0.0.0", manifestVersion: 0 },
    },
  ])("$label", ({ manifest, expected }) => {
    const ext = makeExtensionDir(workspace, "ext/m", manifest);
    expect(readManifest(ext, "extensions_install")).toEqual(expected);
  });

  it.each([
    { label: "a non-JSON manifest", body: "not json", message: /not valid JSON/ },
    { label: "a non-object manifest (array)", body: "[]", message: /must be a JSON object/ },
  ])("throws on $label", ({ body, message }) => {
    const ext = join(workspace, "ext/bad");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "manifest.json"), body, "utf8");
    expect(() => readManifest(ext, "extensions_install")).toThrow(message);
  });
});

// --- buildLaunchArgs -------------------------------------------------------

describe("buildLaunchArgs", () => {
  const mk = (path: string, enabled = true): LoadedExtension => ({
    id: extensionIdFromPath(path),
    name: "n",
    version: "0",
    path,
    enabled,
  });

  it("skips disabled extensions", () => {
    const args = buildLaunchArgs([mk("/a", true), mk("/b", false), mk("/c", true)]);
    expect(args).toEqual(["--disable-extensions-except=/a,/c", "--load-extension=/a,/c"]);
  });
});

// --- refuseIfUnsupported ---------------------------------------------------

describe("refuseIfUnsupported", () => {
  it.each([
    {
      label: "attached/BYOB sessions",
      mode: "attached",
      headless: false,
      error: /attached\/BYOB sessions/,
      hint: /does not own/,
    },
    {
      label: "incognito sessions",
      mode: "incognito",
      headless: false,
      error: /incognito/,
      hint: /allowed in incognito/,
    },
    {
      label: "headless persistent sessions",
      mode: "persistent",
      headless: true,
      error: /headed session/,
      hint: undefined,
    },
  ] as const)("refuses $label", ({ mode, headless, error, hint }) => {
    const r = refuseIfUnsupported({ mode, headless, tool: "extensions_install" });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(error);
    if (hint) expect(r?.hint).toMatch(hint);
  });

  it("returns null for headed persistent sessions", () => {
    expect(
      refuseIfUnsupported({ mode: "persistent", headless: false, tool: "extensions_install" }),
    ).toBeNull();
  });
});

// --- applyInstall / applyUninstall / applyReload --------------------------

describe("applyInstall", () => {
  it("appends a new extension and returns its id", () => {
    const reg = newExtensionRegistry();
    const r = applyInstall(reg, { path: "/p/a", name: "A", version: "1.0" }, "extensions_install");
    expect(r.id).toMatch(/^[a-p]{32}$/);
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0]).toMatchObject({
      id: r.id,
      name: "A",
      version: "1.0",
      path: "/p/a",
      enabled: true,
    });
  });

  it("rejects a duplicate path", () => {
    const path = `${sep}p${sep}a`;
    const reg: ReturnType<typeof newExtensionRegistry> = {
      loaded: [{ id: extensionIdFromPath(path), name: "A", version: "1.0", path, enabled: true }],
    };
    expect(() =>
      applyInstall(reg, { path, name: "A", version: "1.0" }, "extensions_install"),
    ).toThrow(/already loaded/);
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
});

describe("applyReload", () => {
  it("updates name + version from a re-parsed manifest", () => {
    const path = "/p/a";
    const id = extensionIdFromPath(path);
    const reg: ReturnType<typeof newExtensionRegistry> = {
      loaded: [{ id, name: "A", version: "1.0", path, enabled: true }],
    };
    const r = applyReload(
      reg,
      id,
      { name: "A2", version: "2.0", manifestVersion: 3 },
      "extensions_reload",
    );
    expect(r.entry).toMatchObject({ id, name: "A2", version: "2.0" });
    expect(r.loaded).toHaveLength(1);
    expect(r.loaded[0]?.name).toBe("A2");
  });
});

describe("an unknown extension id", () => {
  it.each([
    {
      label: "applyUninstall",
      call: () =>
        applyUninstall(
          newExtensionRegistry(),
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "extensions_uninstall",
        ),
    },
    {
      label: "applyReload",
      call: () =>
        applyReload(
          newExtensionRegistry(),
          "x".repeat(32),
          { name: "n", version: "0", manifestVersion: 3 },
          "extensions_reload",
        ),
    },
  ])("$label throws", ({ call }) => {
    expect(call).toThrow(/no extension with id/);
  });
});
