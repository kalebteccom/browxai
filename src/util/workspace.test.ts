import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertWritableWorkspacePath,
  resolveDefaultProfileDir,
  resolveWorkspace,
  resolveWorkspaceWritePath,
} from "./workspace.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "browx-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveWorkspace (no-trace contract)", () => {
  it("uses BROWX_WORKSPACE env (absolute) and creates it if missing", () => {
    const root = join(tmp, "ws");
    expect(existsSync(root)).toBe(false);
    const ws = resolveWorkspace({ BROWX_WORKSPACE: root });
    expect(ws.root).toBe(resolve(root));
    expect(existsSync(root)).toBe(true);
  });

  it("creates subdirs on demand without polluting cwd", () => {
    const cwdBefore = readdirSync(process.cwd());
    const root = join(tmp, "ws");
    const ws = resolveWorkspace({ BROWX_WORKSPACE: root });
    const profile = ws.sub("profile");
    const logs = ws.sub("logs");
    expect(existsSync(profile)).toBe(true);
    expect(existsSync(logs)).toBe(true);
    expect(profile).toBe(join(resolve(root), "profile"));
    // cwd untouched — the no-trace contract holds for the resolver.
    expect(readdirSync(process.cwd())).toEqual(cwdBefore);
  });

  it("falls back to ~/.browxai when BROWX_WORKSPACE is unset", () => {
    // We don't actually create here — assert path shape only.
    const ws = resolveWorkspace({ BROWX_WORKSPACE: "" });
    expect(ws.root).toMatch(/\.browxai$/);
  });
});

describe("BROWX_DEFAULT_PROFILE", () => {
  it("is unset by default, and the default profile stays <root>/profile", () => {
    expect(resolveDefaultProfileDir({})).toBeUndefined();
    const ws = resolveWorkspace({ BROWX_WORKSPACE: join(tmp, "ws") });
    expect(ws.defaultProfile()).toBe(join(ws.root, "profile"));
  });

  it("creates a missing directory with mode 0700 and the workspace routes to it", () => {
    const dir = join(tmp, "outside", "profile-a");
    const env = { BROWX_WORKSPACE: join(tmp, "ws"), BROWX_DEFAULT_PROFILE: dir };
    expect(resolveDefaultProfileDir(env)).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(resolveWorkspace(env).defaultProfile()).toBe(dir);
  });

  it("accepts an existing directory as is", () => {
    const dir = join(tmp, "existing");
    mkdirSync(dir, { mode: 0o700 });
    expect(resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: dir })).toBe(dir);
  });

  it("refuses a relative path, the root, the home directory, a file and a symlink", () => {
    expect(() => resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: "rel/profile" })).toThrow(
      /absolute path/,
    );
    expect(() => resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: "/" })).toThrow(
      /filesystem root/,
    );
    expect(() => resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: "~" })).toThrow(
      /home directory/,
    );
    const file = join(tmp, "a-file");
    writeFileSync(file, "x");
    expect(() => resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: file })).toThrow(
      /not a directory/,
    );
    const real = join(tmp, "real");
    mkdirSync(real);
    const link = join(tmp, "link");
    symlinkSync(real, link);
    expect(() => resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: link })).toThrow(/symlink/);
    const dangling = join(tmp, "dangling");
    symlinkSync(join(tmp, "nowhere"), dangling);
    expect(() => resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: dangling })).toThrow(/symlink/);
    expect(existsSync(join(tmp, "nowhere"))).toBe(false);
  });

  it("keeps an existing directory's mode (warns, does not chmod) when it is group-readable", () => {
    const dir = join(tmp, "loose");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: dir })).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });
});

describe("protected workspace paths", () => {
  it("refuses the config store, plugin files and profile trees for writes", () => {
    const root = join(tmp, "ws");
    mkdirSync(root);
    for (const p of [
      "config.json",
      "Config.JSON",
      "a/../config.json",
      "plugins.json",
      "plugins-lock.json",
      "plugins/node_modules/x/index.js",
      "profile",
      "profile/Default/Cookies",
      "profiles/a/Cookies",
    ])
      expect(() => resolveWorkspaceWritePath(root, p, "t"), p).toThrow(/refusing to write/);
    expect(resolveWorkspaceWritePath(root, "dumps/config.json", "t")).toBe(
      join(root, "dumps", "config.json"),
    );
    expect(resolveWorkspaceWritePath(root, "profile-notes.txt", "t")).toBe(
      join(root, "profile-notes.txt"),
    );
  });

  it("follows a symlink inside the workspace before deciding", () => {
    const root = join(tmp, "ws2");
    mkdirSync(root);
    symlinkSync(root, join(root, "alias"));
    expect(() => resolveWorkspaceWritePath(root, "alias/config.json", "t")).toThrow(
      /refusing to write/,
    );
  });

  it("refuses the BROWX_DEFAULT_PROFILE tree", () => {
    const root = join(tmp, "ws3");
    mkdirSync(root);
    const env = { BROWX_DEFAULT_PROFILE: join(root, "my-profile") };
    expect(() =>
      assertWritableWorkspacePath(root, join(root, "my-profile", "Cookies"), "t", env),
    ).toThrow(/BROWX_DEFAULT_PROFILE/);
  });
});
