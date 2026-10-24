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
  assertReadableWorkspacePath,
  assertWritableWorkspacePath,
  assertWriteStaysInside,
  resolveDefaultProfileDir,
  resolveWorkspace,
  resolveWorkspaceReadPath,
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
      "profile-snapshots/s1/Cookies",
      "Profile-Snapshots/s1",
      "chrome-profile/Default/Cookies",
      ".browx-snapshot-key",
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

describe("read-protected workspace paths", () => {
  it("refuses operator files and profile trees, allows the rest (including plugins/)", () => {
    const root = join(tmp, "wsr");
    mkdirSync(root);
    for (const p of [
      ".browx-snapshot-key",
      "config.json",
      "plugins.json",
      "profile/Default/Cookies",
      "profiles/a/Cookies",
      "profile-snapshots/s1/Cookies",
      "chrome-profile/Default/Cookies",
    ])
      expect(() => assertReadableWorkspacePath(root, join(root, p), "t"), p).toThrow(
        /refusing to read/,
      );
    expect(() =>
      assertReadableWorkspacePath(root, join(root, "plugins", "x", "index.js"), "t"),
    ).not.toThrow();
    expect(() =>
      assertReadableWorkspacePath(root, join(root, "uploads", "a.png"), "t"),
    ).not.toThrow();
  });
});

describe("read paths stay inside the real workspace", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = join(tmp, "wsl");
    outside = join(tmp, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "s");
  });

  it("refuses a file reached through a directory symlink that leads out", () => {
    mkdirSync(join(root, "plugins", "node_modules"), { recursive: true });
    symlinkSync(outside, join(root, "plugins", "node_modules", "p"));
    expect(() =>
      resolveWorkspaceReadPath(root, "plugins/node_modules/p/secret.txt", "upload_file"),
    ).toThrow(/outside \$BROWX_WORKSPACE/);
    expect(() =>
      assertReadableWorkspacePath(root, join(root, "plugins/node_modules/p/secret.txt"), "t"),
    ).toThrow(/outside \$BROWX_WORKSPACE/);
  });

  it("refuses a file symlink that leads out, and a dangling one", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "s.txt"));
    symlinkSync(join(outside, "not-yet.txt"), join(root, "later.txt"));
    expect(() => assertReadableWorkspacePath(root, join(root, "s.txt"), "drop_files")).toThrow(
      /outside \$BROWX_WORKSPACE/,
    );
    expect(() => assertReadableWorkspacePath(root, join(root, "later.txt"), "t")).toThrow(
      /outside \$BROWX_WORKSPACE/,
    );
  });

  it("allows a symlink that stays inside, and a new file under an existing parent", () => {
    mkdirSync(join(root, "uploads"));
    writeFileSync(join(root, "uploads", "a.png"), "x");
    symlinkSync(join(root, "uploads"), join(root, "alias"));
    expect(resolveWorkspaceReadPath(root, "alias/a.png", "t")).toBe(join(root, "alias", "a.png"));
    expect(resolveWorkspaceReadPath(root, "uploads/new/b.png", "t")).toBe(
      join(root, "uploads", "new", "b.png"),
    );
  });

  it("follows a workspace root that is itself a symlink", () => {
    const linkedRoot = join(tmp, "ws-link");
    symlinkSync(root, linkedRoot);
    writeFileSync(join(root, "a.txt"), "x");
    expect(resolveWorkspaceReadPath(linkedRoot, "a.txt", "t")).toBe(join(linkedRoot, "a.txt"));
  });
});

describe("write paths stay inside the real workspace", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = join(tmp, "wsw");
    outside = join(tmp, "outside-w");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "existing.txt"), "keep");
  });

  it("refuses a new file under a directory symlink that leads out", () => {
    symlinkSync(outside, join(root, "exports"));
    expect(() => resolveWorkspaceWritePath(root, "exports/out.png", "screenshot")).toThrow(
      /refusing to write.*outside \$BROWX_WORKSPACE/,
    );
    expect(() =>
      assertWritableWorkspacePath(root, join(root, "exports", "a", "b.txt"), "t"),
    ).toThrow(/outside \$BROWX_WORKSPACE/);
    expect(existsSync(join(outside, "out.png"))).toBe(false);
  });

  it("refuses a file symlink that leads out, and a dangling one", () => {
    symlinkSync(join(outside, "existing.txt"), join(root, "s.txt"));
    symlinkSync(join(outside, "later.txt"), join(root, "later.txt"));
    expect(() => assertWritableWorkspacePath(root, join(root, "s.txt"), "pdf_save")).toThrow(
      /outside \$BROWX_WORKSPACE/,
    );
    expect(() => assertWritableWorkspacePath(root, join(root, "later.txt"), "pdf_save")).toThrow(
      /outside \$BROWX_WORKSPACE/,
    );
  });

  it("allows a new file under an existing parent, and a link that stays inside", () => {
    mkdirSync(join(root, "shots"));
    symlinkSync(join(root, "shots"), join(root, "alias"));
    expect(resolveWorkspaceWritePath(root, "shots/new/a.png", "t")).toBe(
      join(root, "shots", "new", "a.png"),
    );
    expect(resolveWorkspaceWritePath(root, "alias/a.png", "t")).toBe(join(root, "alias", "a.png"));
  });

  it("keeps the protected-file rules for a path that stays inside", () => {
    expect(() => assertWritableWorkspacePath(root, join(root, "config.json"), "t")).toThrow(
      /only the operator changes/,
    );
    expect(() => assertWritableWorkspacePath(root, join(root, "chrome.profile"), "t")).toThrow(
      /only the operator changes/,
    );
  });

  it("assertWriteStaysInside checks the real path and nothing else", () => {
    symlinkSync(outside, join(root, ".artifacts"));
    expect(() => assertWriteStaysInside(root, join(root, ".artifacts", "s", "a"), "t")).toThrow(
      /outside \$BROWX_WORKSPACE/,
    );
    // Not a protected path: the plain check lets it through.
    expect(() => assertWriteStaysInside(root, join(root, "profile", "x"), "t")).not.toThrow();
  });
});
