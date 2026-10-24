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
  it.each([
    {
      label: "a path that escapes the workspace",
      inputs: ["../escape"],
      message: /must resolve inside/,
    },
    { label: "an empty or whitespace path", inputs: ["", "   "], message: /required/ },
    { label: "a non-existent directory", inputs: ["ext/missing"], message: /not found/ },
    {
      label: "a file (not a directory)",
      inputs: ["not-a-dir.crx"],
      setup: () => writeFileSync(join(workspace, "not-a-dir.crx"), "binary", "utf8"),
      message: /not a directory/,
    },
    {
      label: "a directory missing manifest.json",
      inputs: ["no-manifest"],
      setup: () => mkdirSync(join(workspace, "no-manifest"), { recursive: true }),
      message: /no manifest\.json/,
    },
  ] as Array<{ label: string; inputs: string[]; setup?: () => void; message: RegExp }>)(
    "rejects $label",
    ({ inputs, setup, message }) => {
      setup?.();
      for (const input of inputs) {
        expect(() => resolveExtensionPath(workspace, input, "extensions_install")).toThrow(message);
      }
    },
  );

  it("accepts an absolute path that is INSIDE the workspace", () => {
    const ext = makeExtensionDir(workspace, "ext/inside", {
      name: "inside",
      version: "1.0.0",
      manifest_version: 3,
    });
    expect(resolveExtensionPath(workspace, ext, "extensions_install")).toBe(ext);
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
      hint: /not-owned/,
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
