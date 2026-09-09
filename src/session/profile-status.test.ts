import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  profileStatus,
  profileDirFor,
  MAX_SCAN_ENTRIES,
  type LiveProfileProbe,
} from "./profile-status.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "browx-profstat-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function seedProfile(name: string, files: Record<string, string> = { Cookies: "x" }): string {
  const dir = name === "default" ? join(ws, "profile") : join(ws, "profiles", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

function seedAuthState(name: string, blob: unknown): void {
  mkdirSync(join(ws, ".auth-states"), { recursive: true });
  writeFileSync(join(ws, ".auth-states", `${name}.json`), JSON.stringify(blob));
}

function probe(sessionId: string, profileDir: string, domains: string[]): LiveProfileProbe {
  return { sessionId, profileDir, cookieDomains: async () => domains };
}

describe("profileStatus — inventory", () => {
  it("returns a clean empty result when no profiles root exists yet", async () => {
    const r = await profileStatus(ws, []);
    expect(r.profiles).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.profilesRoot).toBe(join(ws, "profiles"));
  });

  it("enumerates named profiles plus the legacy default dir with size + mtime", async () => {
    seedProfile("default", { Cookies: "abcd" });
    seedProfile("job-search", { Cookies: "123456" });
    seedProfile("job-search-live", { Cookies: "78" });

    const r = await profileStatus(ws, []);
    expect(r.profiles.map((p) => p.name).sort()).toEqual([
      "default",
      "job-search",
      "job-search-live",
    ]);
    const jobSearch = r.profiles.find((p) => p.name === "job-search");
    expect(jobSearch?.path).toBe(join(ws, "profiles", "job-search"));
    expect(jobSearch?.bytes).toBe(6);
    expect(jobSearch?.files).toBe(1);
    expect(Number.isNaN(Date.parse(jobSearch?.modifiedAt ?? ""))).toBe(false);
    // The legacy single-profile dir is addressed as `default`.
    expect(r.profiles.find((p) => p.name === "default")?.path).toBe(join(ws, "profile"));
  });

  it("sums nested directories into bytes and reports the newest mtime", async () => {
    const dir = seedProfile("nested", { top: "aa" });
    mkdirSync(join(dir, "Default", "Network"), { recursive: true });
    writeFileSync(join(dir, "Default", "Network", "Cookies"), "bbbb");
    const future = new Date("2030-01-02T03:04:05.000Z");
    utimesSync(join(dir, "Default", "Network", "Cookies"), future, future);

    const r = await profileStatus(ws, []);
    const row = r.profiles[0];
    expect(row?.bytes).toBe(6);
    expect(row?.files).toBe(2);
    expect(row?.modifiedAt).toBe(future.toISOString());
    expect(row?.scanTruncated).toBeUndefined();
  });

  it("scopes to one profile when `profile` is given, and empties on an unknown name", async () => {
    seedProfile("a");
    seedProfile("b");
    expect((await profileStatus(ws, [], { profile: "a" })).profiles.map((p) => p.name)).toEqual([
      "a",
    ]);
    expect((await profileStatus(ws, [], { profile: "nope" })).profiles).toEqual([]);
  });

  it("does not report a plain file under profiles/ as a profile when scoped to it", async () => {
    mkdirSync(join(ws, "profiles"), { recursive: true });
    writeFileSync(join(ws, "profiles", "notadir"), "x");
    expect((await profileStatus(ws, [], { profile: "notadir" })).profiles).toEqual([]);
  });

  it("skips files and unnameable directories under the profiles root", async () => {
    seedProfile("real");
    writeFileSync(join(ws, "profiles", "stray.txt"), "not a profile");
    // Not a name `open_session({profile})` would accept, so it is not a profile.
    mkdirSync(join(ws, "profiles", "has space"));
    const r = await profileStatus(ws, []);
    expect(r.profiles.map((p) => p.name)).toEqual(["real"]);
  });

  it("warns when the legacy dir and profiles/default both exist", async () => {
    seedProfile("default");
    mkdirSync(join(ws, "profiles", "default"), { recursive: true });
    const r = await profileStatus(ws, []);
    expect(r.profiles.filter((p) => p.name === "default")).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/two directories are named "default"/);
  });
});

describe("profileStatus — live sessions", () => {
  it("marks the profile a live session runs out of, with its session id", async () => {
    const live = seedProfile("job-search-live");
    seedProfile("job-search");
    const r = await profileStatus(ws, [probe("agent-a", live, ["mail.google.com"])]);

    const open = r.profiles.find((p) => p.name === "job-search-live");
    expect(open?.live?.sessions).toEqual(["agent-a"]);
    expect(open?.live?.cookieDomains).toEqual(["mail.google.com"]);
    expect(Number.isNaN(Date.parse(open?.live?.observedAt ?? ""))).toBe(false);
    // The idle sibling carries no live block at all — absence, never a guess.
    expect(r.profiles.find((p) => p.name === "job-search")?.live).toBeUndefined();
  });

  it("merges two sessions sharing one profile and de-duplicates their domains", async () => {
    const dir = seedProfile("shared");
    const r = await profileStatus(ws, [
      probe("b", dir, ["example.test", "a.test"]),
      probe("a", dir, ["example.test"]),
    ]);
    expect(r.profiles[0]?.live?.sessions).toEqual(["a", "b"]);
    expect(r.profiles[0]?.live?.cookieDomains).toEqual(["a.test", "example.test"]);
  });

  it("still reports the session when the cookie read fails (no invented domains)", async () => {
    const dir = seedProfile("safari-ish");
    const r = await profileStatus(ws, [
      {
        sessionId: "s1",
        profileDir: dir,
        cookieDomains: () => Promise.reject(new Error("no playwright page")),
      },
    ]);
    expect(r.profiles[0]?.live?.sessions).toEqual(["s1"]);
    expect(r.profiles[0]?.live?.cookieDomains).toBeUndefined();
  });

  it("ignores probes whose profile dir is not in the workspace inventory", async () => {
    seedProfile("known");
    const r = await profileStatus(ws, [probe("ghost", join(ws, "profiles", "gone"), ["x.test"])]);
    expect(r.profiles[0]?.live).toBeUndefined();
  });
});

describe("profileStatus — saved auth states", () => {
  it("attaches the same-named slot's domains and origins, dated to the save", async () => {
    seedProfile("job-search-live");
    seedAuthState("job-search-live", {
      cookies: [
        { name: "SID", domain: ".google.com" },
        { name: "X", domain: ".google.com" },
      ],
      origins: [{ origin: "https://mail.google.com", localStorage: [] }],
    });
    const r = await profileStatus(ws, []);
    const saved = r.profiles[0]?.savedAuthState;
    expect(saved?.name).toBe("job-search-live");
    expect(saved?.path).toBe(join(ws, ".auth-states", "job-search-live.json"));
    expect(saved?.cookieDomains).toEqual([".google.com"]);
    expect(saved?.originsWithLocalStorage).toEqual(["https://mail.google.com"]);
    expect(Number.isNaN(Date.parse(saved?.savedAt ?? ""))).toBe(false);
  });

  it("omits the block when no slot matches the profile name", async () => {
    seedProfile("lonely");
    seedAuthState("someone-else", { cookies: [], origins: [] });
    expect((await profileStatus(ws, [])).profiles[0]?.savedAuthState).toBeUndefined();
  });

  it("omits the block on a corrupt slot rather than reporting a partial one", async () => {
    seedProfile("broken");
    mkdirSync(join(ws, ".auth-states"), { recursive: true });
    writeFileSync(join(ws, ".auth-states", "broken.json"), "{not json");
    expect((await profileStatus(ws, [])).profiles[0]?.savedAuthState).toBeUndefined();
  });
});

describe("profileDirFor — workspace containment", () => {
  it("refuses a name that escapes the workspace root", () => {
    expect(() => profileDirFor(ws, "../../etc")).toThrow(/must resolve inside \$BROWX_WORKSPACE/);
    expect(() => profileDirFor(ws, "../../../tmp")).toThrow(
      /must resolve inside \$BROWX_WORKSPACE/,
    );
  });

  it("refuses a traversal name that resolves back onto the workspace root itself", () => {
    // `profiles/..` lands ON the root, which the containment check permits — the
    // single-segment name rule is what refuses it.
    expect(() => profileDirFor(ws, "..")).toThrow(/invalid/);
  });

  it("refuses a separator-bearing or empty name that stays inside the workspace", () => {
    expect(() => profileDirFor(ws, "a/b")).toThrow(/invalid/);
    expect(() => profileDirFor(ws, "")).toThrow(/invalid/);
  });

  it("propagates the refusal out of profileStatus rather than listing anything", async () => {
    seedProfile("real");
    await expect(profileStatus(ws, [], { profile: "../../etc" })).rejects.toThrow(
      /must resolve inside \$BROWX_WORKSPACE/,
    );
  });

  it("maps `default` to the legacy dir and any other name under profiles/", () => {
    expect(profileDirFor(ws, "default")).toBe(join(ws, "profile"));
    expect(profileDirFor(ws, "agent-a")).toBe(join(ws, "profiles", "agent-a"));
  });
});

describe("profileStatus — the scan budget", () => {
  it("stops at the budget and flags the row instead of walking the whole tree", async () => {
    const dir = seedProfile("huge", {});
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}`), "0123456789");
    const r = await profileStatus(ws, [], { maxEntries: 5 });
    expect(r.profiles[0]?.scanTruncated).toBe(true);
    expect(r.profiles[0]?.files).toBeLessThanOrEqual(5);
    expect(r.profiles[0]?.bytes).toBeLessThan(200);
  });

  it("spends one budget across the whole call, so a huge profile can't starve a later one", async () => {
    const first = seedProfile("aaa", {});
    for (let i = 0; i < 20; i++) writeFileSync(join(first, `f${i}`), "x");
    seedProfile("bbb", { one: "x" });
    const r = await profileStatus(ws, [], { maxEntries: 6 });
    expect(r.profiles.map((p) => p.name)).toEqual(["aaa", "bbb"]);
    expect(r.profiles[0]?.scanTruncated).toBe(true);
    expect(r.profiles[1]?.scanTruncated).toBe(true);
    expect(r.profiles[1]?.files).toBe(0);
  });

  it("ships a positive default budget", () => {
    expect(MAX_SCAN_ENTRIES).toBeGreaterThan(0);
  });

  it("leaves a within-budget profile unflagged and exact", async () => {
    seedProfile("small", { a: "12", b: "345" });
    const r = await profileStatus(ws, []);
    expect(r.profiles[0]?.scanTruncated).toBeUndefined();
    expect(r.profiles[0]?.bytes).toBe(5);
    expect(r.profiles[0]?.files).toBe(2);
  });
});
