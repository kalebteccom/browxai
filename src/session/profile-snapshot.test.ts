import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotProfile, restoreProfile } from "./profile-snapshot.js";

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "browx-prof-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

function seedProfile(profile: string | undefined, file: string, content: string): void {
  const dir = profile && profile !== "default"
    ? join(ws, "profiles", profile)
    : join(ws, "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
}

describe("snapshotProfile", () => {
  it("copies the default profile dir into a named snapshot", () => {
    seedProfile("default", "cookies.txt", "session=abc");
    const r = snapshotProfile(ws, undefined, "clean");
    expect(r).toEqual({ ok: true, action: "snapshot", profile: "default", snapshot: "clean" });
    expect(readFileSync(join(ws, "profile-snapshots", "clean", "cookies.txt"), "utf8")).toBe("session=abc");
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
