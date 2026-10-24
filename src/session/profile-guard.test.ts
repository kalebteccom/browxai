import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  it.each([
    {
      label: "uses the workspace default profile when no profile is named, whatever the session id",
      names: [undefined, ""],
      expected: ["profile"],
    },
    {
      label: "maps an explicit name to <workspace>/profiles/<name>",
      names: ["work"],
      expected: ["profiles", "work"],
    },
  ])("$label", ({ names, expected }) => {
    const ws = resolveWorkspace({ BROWX_WORKSPACE: root });
    for (const name of names) expect(resolveProfileDir(ws, name)).toBe(join(root, ...expected));
  });

  it("refuses a name that is not one plain directory name, and creates nothing", () => {
    const ws = resolveWorkspace({ BROWX_WORKSPACE: join(root, "ws") });
    const bad = [
      "../x",
      "../../x",
      "a/../b",
      "a/b",
      "a\\b",
      join(root, "abs"),
      "..",
      "a\0b",
      "x".repeat(129),
    ];
    for (const name of bad) {
      expect(() => resolveProfileDir(ws, name), JSON.stringify(name)).toThrow(/^invalid-name:/);
    }
    // The workspace root exists; nothing else was created, inside or beside it.
    expect(readdirSync(root)).toEqual(["ws"]);
    expect(readdirSync(join(root, "ws"))).toEqual([]);
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

  it.each([
    {
      label: "allows a different directory",
      sessions: live,
      id: "agent-b",
      dir: "/ws/profiles/other",
      profile: "other",
    },
    {
      label: "ignores sessions with no profile directory",
      sessions: [{ id: "incog", session: {} }],
      id: "x",
      dir: "/ws/profile",
      profile: undefined,
    },
    {
      label: "does not refuse a session against itself",
      sessions: live,
      id: "agent-a",
      dir: "/ws/profile",
      profile: undefined,
    },
  ])("$label", ({ sessions, id, dir, profile }) => {
    expect(liveProfileRefusal(sessions, id, dir, profile)).toBeNull();
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

  it.each([
    {
      label: "finds a live Chrome on this host",
      target: () => `${hostname()}-${process.pid}`,
      holder: () => ({ pid: process.pid }),
    },
    {
      label: "ignores a stale lock whose pid is gone",
      target: () => `${hostname()}-2147483646`,
      holder: () => null,
    },
    {
      label: "leaves a lock from another host to Chrome",
      target: () => `some-other-host-${process.pid}`,
      holder: () => null,
    },
  ])("$label", ({ target, holder }) => {
    lockTo(target());
    expect(profileLockHolder(root)).toEqual(holder());
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
});
