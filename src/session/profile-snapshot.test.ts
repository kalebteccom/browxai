import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  cpSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotProfile, restoreProfile, treeDigest } from "./profile-snapshot.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "browx-prof-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function seedProfile(profile: string | undefined, file: string, content: string): void {
  const dir =
    profile && profile !== "default" ? join(ws, "profiles", profile) : join(ws, "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
}

describe("snapshotProfile", () => {
  it("copies the default profile dir into a named snapshot", () => {
    seedProfile("default", "cookies.txt", "session=abc");
    const r = snapshotProfile(ws, undefined, "clean");
    expect(r).toEqual({ ok: true, action: "snapshot", profile: "default", snapshot: "clean" });
    expect(readFileSync(join(ws, "profile-snapshots", "clean", "cookies.txt"), "utf8")).toBe(
      "session=abc",
    );
  });

  it("snapshots a named profile under profiles/", () => {
    seedProfile("agent-a", "state.json", "{}");
    snapshotProfile(ws, "agent-a", "snap1");
    expect(existsSync(join(ws, "profile-snapshots", "snap1", "state.json"))).toBe(true);
  });

  it("throws when the profile dir does not exist", () => {
    expect(() => snapshotProfile(ws, undefined, "x")).toThrow(/no profile directory/);
  });

  it("rejects path-traversal in names", () => {
    seedProfile("default", "f", "x");
    expect(() => snapshotProfile(ws, undefined, "../escape")).toThrow(/invalid/);
    expect(() => snapshotProfile(ws, "../p", "ok")).toThrow(/invalid/);
  });
});

describe("restoreProfile", () => {
  it("restores a snapshot back over a mutated profile", () => {
    seedProfile("default", "data.txt", "ORIGINAL");
    snapshotProfile(ws, undefined, "baseline");
    // simulate a destructive test mutating the profile
    writeFileSync(join(ws, "profile", "data.txt"), "MUTATED");
    const r = restoreProfile(ws, undefined, "baseline");
    expect(r).toEqual({ ok: true, action: "restore", profile: "default", snapshot: "baseline" });
    expect(readFileSync(join(ws, "profile", "data.txt"), "utf8")).toBe("ORIGINAL");
  });

  it("throws when the snapshot does not exist", () => {
    seedProfile("default", "f", "x");
    expect(() => restoreProfile(ws, undefined, "nope")).toThrow(/no snapshot/);
  });
});

describe("snapshot provenance", () => {
  it("refuses a snapshot directory profile_snapshot did not write", () => {
    const forged = join(ws, "profile-snapshots", "planted");
    mkdirSync(forged, { recursive: true });
    writeFileSync(join(forged, "Cookies"), "attacker");
    expect(() => restoreProfile(ws, undefined, "planted")).toThrow(/no snapshot manifest/);
    expect(existsSync(join(ws, "profile", "Cookies"))).toBe(false);
  });

  it("refuses a snapshot whose files changed after it was taken", () => {
    seedProfile("default", "data.txt", "ORIGINAL");
    snapshotProfile(ws, undefined, "s1");
    writeFileSync(join(ws, "profile-snapshots", "s1", "data.txt"), "TAMPERED");
    expect(() => restoreProfile(ws, undefined, "s1")).toThrow(/changed after it was taken/);
    writeFileSync(join(ws, "profile-snapshots", "s1", "data.txt"), "ORIGINAL");
    writeFileSync(join(ws, "profile-snapshots", "s1", "extra"), "x");
    expect(() => restoreProfile(ws, undefined, "s1")).toThrow(/changed after it was taken/);
  });

  it("refuses a manifest signed with another key, or copied from another snapshot name", () => {
    seedProfile("default", "data.txt", "ORIGINAL");
    snapshotProfile(ws, undefined, "s1");
    // Same bytes under a different name: the MAC binds the name.
    cpSync(join(ws, "profile-snapshots", "s1"), join(ws, "profile-snapshots", "s2"), {
      recursive: true,
    });
    expect(() => restoreProfile(ws, undefined, "s2")).toThrow(/not signed by this workspace/);
    // A rotated key invalidates old manifests.
    writeFileSync(join(ws, ".browx-snapshot-key"), Buffer.alloc(32, 7));
    expect(() => restoreProfile(ws, undefined, "s1")).toThrow(/not signed by this workspace/);
  });

  it("the manifest never lands in the restored profile, and re-snapshot replaces", () => {
    seedProfile("default", "a.txt", "A");
    snapshotProfile(ws, undefined, "s1");
    rmSync(join(ws, "profile", "a.txt"));
    seedProfile("default", "b.txt", "B");
    snapshotProfile(ws, undefined, "s1");
    expect(existsSync(join(ws, "profile-snapshots", "s1", "a.txt"))).toBe(false);
    restoreProfile(ws, undefined, "s1");
    expect(existsSync(join(ws, "profile", ".browx-snapshot.json"))).toBe(false);
  });

  it("default resolves to the given default profile dir (BROWX_DEFAULT_PROFILE)", () => {
    const external = mkdtempSync(join(tmpdir(), "browx-prof-ext-"));
    try {
      writeFileSync(join(external, "Cookies"), "EXT");
      snapshotProfile(ws, undefined, "ext", external);
      writeFileSync(join(external, "Cookies"), "MUTATED");
      restoreProfile(ws, "default", "ext", external);
      expect(readFileSync(join(external, "Cookies"), "utf8")).toBe("EXT");
      expect(existsSync(join(ws, "profile"))).toBe(false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("restore replaces the profile with exactly the snapshot", () => {
  it("does not write through a symlink left in the profile", () => {
    const outside = mkdtempSync(join(tmpdir(), "browx-prof-outside-"));
    try {
      writeFileSync(join(outside, "target"), "UNTOUCHED");
      seedProfile("default", "Cookies", "SNAPSHOT");
      snapshotProfile(ws, undefined, "s1");
      rmSync(join(ws, "profile", "Cookies"));
      symlinkSync(join(outside, "target"), join(ws, "profile", "Cookies"));
      restoreProfile(ws, undefined, "s1");
      expect(readFileSync(join(outside, "target"), "utf8")).toBe("UNTOUCHED");
      expect(lstatSync(join(ws, "profile", "Cookies")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(ws, "profile", "Cookies"), "utf8")).toBe("SNAPSHOT");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("drops files the snapshot does not hold", () => {
    seedProfile("default", "kept", "K");
    snapshotProfile(ws, undefined, "s1");
    writeFileSync(join(ws, "profile", "stale"), "S");
    restoreProfile(ws, undefined, "s1");
    expect(readdirSync(join(ws, "profile")).sort()).toEqual(["kept"]);
  });

  it("restores over a leftover Singleton* symlink without EEXIST", () => {
    seedProfile("default", "data", "D");
    symlinkSync("host-1", join(ws, "profile", "SingletonLock"));
    snapshotProfile(ws, undefined, "s1");
    rmSync(join(ws, "profile", "SingletonLock"));
    symlinkSync("host-2", join(ws, "profile", "SingletonLock"));
    restoreProfile(ws, undefined, "s1");
    expect(readlinkSync(join(ws, "profile", "SingletonLock"))).toBe("host-1");
    // No temp or aside directories are left next to the profile.
    expect(readdirSync(ws).filter((n) => n.startsWith(".profile."))).toEqual([]);
  });

  it("refuses when the profile directory itself is a symlink", () => {
    seedProfile("default", "data", "D");
    snapshotProfile(ws, undefined, "s1");
    const elsewhere = mkdtempSync(join(tmpdir(), "browx-prof-link-"));
    try {
      rmSync(join(ws, "profile"), { recursive: true });
      symlinkSync(elsewhere, join(ws, "profile"));
      expect(() => restoreProfile(ws, undefined, "s1")).toThrow(/is a symlink/);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("keeps the profile directory's mode", () => {
    seedProfile("default", "data", "D");
    chmodSync(join(ws, "profile"), 0o700);
    snapshotProfile(ws, undefined, "s1");
    restoreProfile(ws, undefined, "s1");
    expect(statSync(join(ws, "profile")).mode & 0o777).toBe(0o700);
  });
});

describe("snapshot manifest and tree edge cases", () => {
  it("refuses a malformed or unreadable manifest", () => {
    seedProfile("default", "data", "D");
    snapshotProfile(ws, undefined, "s1");
    const mf = join(ws, "profile-snapshots", "s1", ".browx-snapshot.json");
    writeFileSync(mf, "{ not json");
    expect(() => restoreProfile(ws, undefined, "s1")).toThrow(/manifest is unreadable/);
    writeFileSync(mf, JSON.stringify({ version: 2, digest: "x", mac: "y" }));
    expect(() => restoreProfile(ws, undefined, "s1")).toThrow(/manifest is malformed/);
    writeFileSync(mf, JSON.stringify({ version: 1, digest: 5, mac: "y" }));
    expect(() => restoreProfile(ws, undefined, "s1")).toThrow(/manifest is malformed/);
  });

  it("refuses a tree past the entry cap", () => {
    const dir = join(ws, "many");
    mkdirSync(dir);
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}`), "x");
    expect(() => treeDigest(dir, 4)).toThrow(/too many entries/);
    expect(treeDigest(dir, 5)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a snapshot holding a symlink records the link, not what it points at", () => {
    const outside = mkdtempSync(join(tmpdir(), "browx-prof-sym-"));
    try {
      writeFileSync(join(outside, "secret"), "OUTSIDE");
      seedProfile("default", "data", "D");
      symlinkSync(join(outside, "secret"), join(ws, "profile", "link"));
      snapshotProfile(ws, undefined, "s1");
      const snapLink = join(ws, "profile-snapshots", "s1", "link");
      expect(lstatSync(snapLink).isSymbolicLink()).toBe(true);
      // Changing the target's bytes does not change the snapshot's digest…
      writeFileSync(join(outside, "secret"), "CHANGED");
      expect(() => restoreProfile(ws, undefined, "s1")).not.toThrow();
      // …but retargeting the link does.
      rmSync(snapLink);
      symlinkSync("/elsewhere", snapLink);
      expect(() => restoreProfile(ws, undefined, "s1")).toThrow(/changed after it was taken/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
