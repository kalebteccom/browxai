import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSchedule,
  validateScheduleArgs,
  defaultScheduleDir,
  ensureWorkspaceDir,
  MAX_CAPTURES_PER_CALL,
  type ScheduleClock,
  type SnapFn,
} from "./screenshot-schedule.js";

let WS: string;
beforeEach(() => { WS = mkdtempSync(join(tmpdir(), "browx-sched-")); });
afterEach(() => { rmSync(WS, { recursive: true, force: true }); });

/** Tiny PNG-ish payload — the controller writes bytes verbatim. */
function fakePng(seed = 0): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[4] = seed & 0xff;
  return b;
}

/** Virtual clock — no real timers; sleeps advance `now` deterministically. */
function virtualClock(): ScheduleClock & { advance(ms: number): void } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms) => { t += Math.max(0, ms); return Promise.resolve(); },
    advance: (ms) => { t += ms; },
  };
}

describe("validateScheduleArgs", () => {
  it("rejects everyMs below the floor", () => {
    expect(() => validateScheduleArgs({ everyMs: 50, count: 2, intoDir: "x" }))
      .toThrow(/everyMs/);
  });
  it("rejects everyMs above the ceiling", () => {
    expect(() => validateScheduleArgs({ everyMs: 60_001, count: 2, intoDir: "x" }))
      .toThrow(/everyMs/);
  });
  it("rejects when neither count nor durationMs is supplied", () => {
    expect(() => validateScheduleArgs({ everyMs: 200, intoDir: "x" }))
      .toThrow(/either `count`/);
  });
  it("rejects when both count and durationMs are supplied (mutex)", () => {
    expect(() => validateScheduleArgs({ everyMs: 200, count: 3, durationMs: 1000, intoDir: "x" }))
      .toThrow(/mutually exclusive/);
  });
  it("rejects count outside [1, MAX_CAPTURES_PER_CALL]", () => {
    expect(() => validateScheduleArgs({ everyMs: 200, count: 0, intoDir: "x" })).toThrow(/count/);
    expect(() => validateScheduleArgs({ everyMs: 200, count: MAX_CAPTURES_PER_CALL + 1, intoDir: "x" })).toThrow(/count/);
  });
  it("rejects durationMs < everyMs (cadence couldn't fire even once)", () => {
    expect(() => validateScheduleArgs({ everyMs: 500, durationMs: 100, intoDir: "x" }))
      .toThrow(/durationMs/);
  });
  it("accepts a well-formed count-bounded schedule", () => {
    expect(() => validateScheduleArgs({ everyMs: 200, count: 3, intoDir: "x" })).not.toThrow();
  });
  it("accepts a well-formed duration-bounded schedule", () => {
    expect(() => validateScheduleArgs({ everyMs: 200, durationMs: 1000, intoDir: "x" })).not.toThrow();
  });
});

describe("runSchedule — happy paths", () => {
  it("count-bounded: writes exactly N files and returns matching paths/capturedAt", async () => {
    let i = 0;
    const snap: SnapFn = () => Promise.resolve(fakePng(i++));
    const clock = virtualClock();
    const r = await runSchedule(snap, {
      everyMs: 200, count: 3, intoDir: "shots/run-a",
    }, WS, clock);
    expect(r.count).toBe(3);
    expect(r.paths).toHaveLength(3);
    expect(r.capturedAt).toHaveLength(3);
    expect(r.warnings).toEqual([]);
    expect(r.intoDir).toBe(join(WS, "shots/run-a"));
    for (const p of r.paths) expect(existsSync(p)).toBe(true);
    // capturedAt should be roughly 0, 200, 400 (virtual clock is exact).
    expect(r.capturedAt[0]).toBe(0);
    expect(r.capturedAt[1]).toBe(200);
    expect(r.capturedAt[2]).toBe(400);
  });

  it("duration-bounded: stops when wall-clock exceeds durationMs", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const clock = virtualClock();
    const r = await runSchedule(snap, {
      everyMs: 200, durationMs: 700, intoDir: "shots/dur",
    }, WS, clock);
    // 0ms, 200ms, 400ms, 600ms → 4 captures; the next tick would land at 800ms.
    expect(r.count).toBe(4);
    expect(r.capturedAt.every((t) => t < 700)).toBe(true);
  });

  it("file extension follows the format", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const clock = virtualClock();
    const r = await runSchedule(snap, {
      everyMs: 200, count: 2, intoDir: "shots/fmt", format: "jpeg",
    }, WS, clock);
    for (const p of r.paths) expect(p.endsWith(".jpg")).toBe(true);
  });

  it("written files contain the snap-returned bytes", async () => {
    let n = 0;
    const snap: SnapFn = () => Promise.resolve(fakePng(n++));
    const clock = virtualClock();
    const r = await runSchedule(snap, {
      everyMs: 200, count: 2, intoDir: "shots/bytes",
    }, WS, clock);
    expect(readFileSync(r.paths[0]!)[4]).toBe(0);
    expect(readFileSync(r.paths[1]!)[4]).toBe(1);
  });
});

describe("runSchedule — error & safety paths", () => {
  it("a single failed snap surfaces as a warning and the schedule continues", async () => {
    let n = 0;
    const snap: SnapFn = () => {
      const i = n++;
      if (i === 1) return Promise.reject(new Error("transient renderer hiccup"));
      return Promise.resolve(fakePng(i));
    };
    const clock = virtualClock();
    const r = await runSchedule(snap, {
      everyMs: 200, count: 3, intoDir: "shots/err",
    }, WS, clock);
    expect(r.count).toBe(2);                       // 2 successful writes
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/transient renderer hiccup/);
  });

  it("rejects a path that escapes the workspace", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    await expect(runSchedule(snap, {
      everyMs: 200, count: 2, intoDir: "../escape",
    }, WS, virtualClock())).rejects.toThrow(/\$BROWX_WORKSPACE/);
  });

  it("creates a nested intoDir if missing", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const r = await runSchedule(snap, {
      everyMs: 200, count: 1, intoDir: "deeply/nested/shots",
    }, WS, virtualClock());
    expect(existsSync(join(WS, "deeply/nested/shots"))).toBe(true);
    expect(readdirSync(r.intoDir)).toHaveLength(1);
  });
});

describe("defaultScheduleDir", () => {
  it("uses a filesystem-friendly ISO timestamp", () => {
    const d = defaultScheduleDir("sess-A", new Date("2026-06-08T12:34:56.789Z"));
    expect(d).toBe("screenshots/sess-A-2026-06-08T12-34-56-789Z");
    // no `:` or `.` survives — windows/macOS-safe
    expect(d.includes(":")).toBe(false);
    expect(d.includes(".")).toBe(false);
  });
});

describe("ensureWorkspaceDir", () => {
  it("creates the dir under the workspace and returns the absolute path", () => {
    const p = ensureWorkspaceDir(WS, "evt/shots", "screenshot_on");
    expect(p).toBe(join(WS, "evt/shots"));
    expect(existsSync(p)).toBe(true);
  });
  it("rejects path traversal", () => {
    expect(() => ensureWorkspaceDir(WS, "../bad", "screenshot_on"))
      .toThrow(/\$BROWX_WORKSPACE/);
  });
});
