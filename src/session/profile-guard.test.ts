import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  liveProfileRefusal,
  profileLockHolder,
  refuseLiveProfile,
  refuseLockedProfile,
  resolveProfileDir,
} from "./profile-guard.js";
import { resolveWorkspace } from "../util/workspace.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "browxai-profile-guard-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveProfileDir", () => {
  it("uses the workspace default profile when no profile is named, whatever the session id", () => {
    const ws = resolveWorkspace({ BROWX_WORKSPACE: root });
    // The session id is not an input: every id resolves to the same directory.
    expect(resolveProfileDir(ws, undefined)).toBe(join(root, "profile"));
    expect(resolveProfileDir(ws, "")).toBe(join(root, "profile"));
  });

  it("follows BROWX_DEFAULT_PROFILE for the default", () => {
    const custom = join(root, "elsewhere");
    mkdirSync(custom, { mode: 0o700 });
    const ws = resolveWorkspace({ BROWX_WORKSPACE: root, BROWX_DEFAULT_PROFILE: custom });
    expect(resolveProfileDir(ws, undefined)).toBe(custom);
  });

  it("maps an explicit name to <workspace>/profiles/<name>", () => {
    const ws = resolveWorkspace({ BROWX_WORKSPACE: root });
    expect(resolveProfileDir(ws, "work")).toBe(join(root, "profiles", "work"));
  });
});

describe("liveProfileRefusal", () => {
  const live = [
    { id: "agent-a", session: { profileDir: "/ws/profile" } },
    { id: "incog", session: {} },
  ];

  it("names the profile, the holder and the ways out", () => {
    const msg = liveProfileRefusal(live, "agent-b", "/ws/profile", undefined)!;
    expect(msg).toMatch(/^profile-in-use:/);
    expect(msg).toContain('session "agent-b"');
    expect(msg).toContain("the workspace default profile (/ws/profile)");
    expect(msg).toContain('session "agent-a" has it open');
    expect(msg).toContain("explicit `profile`");
    expect(msg).toContain('"incognito"');
  });

  it("names an explicit profile by its name", () => {
    const msg = liveProfileRefusal(
      [{ id: "a", session: { profileDir: "/ws/profiles/work" } }],
      "b",
      "/ws/profiles/work",
      "work",
    )!;
    expect(msg).toContain('profile "work"');
  });

  it("allows a different directory, and ignores sessions with no profile directory", () => {
    expect(liveProfileRefusal(live, "agent-b", "/ws/profiles/other", "other")).toBeNull();
    expect(
      liveProfileRefusal([{ id: "incog", session: {} }], "x", "/ws/profile", undefined),
    ).toBeNull();
  });

  it("does not refuse a session against itself", () => {
    expect(liveProfileRefusal(live, "agent-a", "/ws/profile", undefined)).toBeNull();
  });
});

describe("refuseLiveProfile", () => {
  it("throws the refusal as an Error and passes when the profile is free", () => {
    const registry = { list: () => [{ id: "a", session: { profileDir: "/ws/profile" } }] };
    expect(() => refuseLiveProfile(registry, "b", "/ws/profile", undefined)).toThrow(
      /profile-in-use.*session "a" has it open/,
    );
    expect(() => refuseLiveProfile(registry, "b", "/ws/profiles/x", "x")).not.toThrow();
  });
});

describe("profileLockHolder", () => {
  const lockTo = (target: string): void => symlinkSync(target, join(root, "SingletonLock"));

  it("finds a live Chrome on this host", () => {
    lockTo(`${hostname()}-${process.pid}`);
    expect(profileLockHolder(root)).toEqual({ pid: process.pid });
  });

  it("ignores a stale lock whose pid is gone", () => {
    lockTo(`${hostname()}-2147483646`);
    expect(profileLockHolder(root)).toBeNull();
  });

  it("leaves a lock from another host to Chrome", () => {
    lockTo(`some-other-host-${process.pid}`);
    expect(profileLockHolder(root)).toBeNull();
  });

  it("is null for an unlocked profile", () => {
    expect(profileLockHolder(root)).toBeNull();
    expect(profileLockHolder(join(root, "missing"))).toBeNull();
  });

  it("reads the Windows lockfile", () => {
    expect(profileLockHolder(root, "win32")).toBeNull();
    writeFileSync(join(root, "lockfile"), "");
    expect(profileLockHolder(root, "win32")).toEqual({});
  });
});

describe("refuseLockedProfile", () => {
  it("names the profile, the pid and the ways out", () => {
    symlinkSync(`${hostname()}-${process.pid}`, join(root, "SingletonLock"));
    expect(() => refuseLockedProfile(root, "agent-b")).toThrow(
      new RegExp(`profile-in-use.*agent-b.*pid ${process.pid}.*incognito`),
    );
  });

  it("passes for an unlocked profile", () => {
    expect(() => refuseLockedProfile(root, "agent-b")).not.toThrow();
  });
});
