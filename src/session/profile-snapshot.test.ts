import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotProfile, restoreProfile } from "./profile-snapshot.js";

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
