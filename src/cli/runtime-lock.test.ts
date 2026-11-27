import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import { appendJournal, readJournal } from "./runtime-journal.js";
import { acquireLock, LOCK_MAX_AGE_MS } from "./runtime-lock.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("the lock", () => {
  it("is taken with the pid and start time, mode 0600, and released", () => {
    rt = tempRuntime();
    const lock = acquireLock(rt.paths, { now: () => NOW, pid: 4242 });
    expect(lock.ok).toBe(true);
    expect(JSON.parse(readFileSync(rt.paths.lock, "utf8"))).toEqual({
      pid: 4242,
      startedAt: iso(NOW),
    });
    expect(statSync(rt.paths.lock).mode & 0o777).toBe(0o600);
    if (lock.ok) lock.release();
    expect(existsSync(rt.paths.lock)).toBe(false);
  });

  it("refuses a second run while the first one's pid is alive and the lock is young", () => {
    rt = tempRuntime();
    expect(acquireLock(rt.paths, { now: () => NOW, pid: 1, alive: () => true }).ok).toBe(true);
    expect(acquireLock(rt.paths, { now: () => NOW + 1000, pid: 2, alive: () => true })).toEqual({
      ok: false,
      pid: 1,
      startedAt: iso(NOW),
    });
  });

  it("takes over a lock whose pid is gone", () => {
    rt = tempRuntime();
    acquireLock(rt.paths, { now: () => NOW, pid: 1 });
    const second = acquireLock(rt.paths, { now: () => NOW, pid: 2, alive: () => false });
    expect(second.ok).toBe(true);
    expect(JSON.parse(readFileSync(rt.paths.lock, "utf8"))).toMatchObject({ pid: 2 });
  });

  it("takes over a lock older than an hour even when its pid lives", () => {
    rt = tempRuntime();
    acquireLock(rt.paths, { now: () => NOW, pid: 1 });
    const later = () => NOW + LOCK_MAX_AGE_MS + 1;
    expect(acquireLock(rt.paths, { now: later, pid: 2, alive: () => true }).ok).toBe(true);
    expect(LOCK_MAX_AGE_MS).toBe(60 * 60 * 1000);
  });

  it("takes over a torn lock file", () => {
    rt = tempRuntime();
    writeFileSync(rt.paths.lock, "{");
    expect(acquireLock(rt.paths, { now: () => NOW, pid: 2, alive: () => true }).ok).toBe(true);
  });

  it("release leaves a lock another run took over alone", () => {
    rt = tempRuntime();
    const first = acquireLock(rt.paths, { now: () => NOW, pid: 1 });
    writeFileSync(rt.paths.lock, JSON.stringify({ pid: 2, startedAt: iso(NOW) }));
    if (first.ok) first.release();
    expect(existsSync(rt.paths.lock)).toBe(true);
  });
});

describe("the journal", () => {
  it("appends one JSON line per entry, mode 0600", () => {
    rt = tempRuntime();
    appendJournal(rt.paths, { at: iso(NOW), event: "check", result: "up to date on 0.22.0" });
    appendJournal(rt.paths, { at: iso(NOW), event: "apply", version: "0.23.0", ms: 12 });
    expect(readJournal(rt.paths)).toEqual([
      { at: iso(NOW), event: "check", result: "up to date on 0.22.0" },
      { at: iso(NOW), event: "apply", version: "0.23.0", ms: 12 },
    ]);
    expect(statSync(rt.paths.journal).mode & 0o777).toBe(0o600);
  });

  it("moves a full journal to journal.jsonl.1, keeping one rotation", () => {
    rt = tempRuntime();
    const entry = { at: iso(NOW), event: "check" as const, result: "x".repeat(40) };
    const size = Buffer.byteLength(JSON.stringify(entry) + "\n");
    for (let i = 0; i < 3; i++) appendJournal(rt.paths, entry, size * 2);
    expect(readJournal(rt.paths)).toHaveLength(1);
    expect(readFileSync(`${rt.paths.journal}.1`, "utf8").trim().split("\n")).toHaveLength(2);
    for (let i = 0; i < 2; i++) appendJournal(rt.paths, entry, size * 2);
    expect(readFileSync(`${rt.paths.journal}.1`, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readJournal(rt.paths)).toHaveLength(1);
  });

  it("skips a torn line, and never throws when it can't write", () => {
    rt = tempRuntime();
    writeFileSync(rt.paths.journal, '{"at":"x","event":"check"}\n{"at":');
    expect(readJournal(rt.paths)).toEqual([{ at: "x", event: "check" }]);
    const missing = { ...rt.paths, journal: "/nonexistent/dir/journal.jsonl" };
    expect(() => appendJournal(missing, { at: iso(NOW), event: "gc" })).not.toThrow();
  });
});
