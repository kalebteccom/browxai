import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runSchedule,
  validateScheduleArgs,
  defaultScheduleDir,
  MAX_CAPTURES_PER_CALL,
  type ScheduleClock,
  type SnapFn,
} from "./screenshot-schedule.js";

let WS: string;
beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), "browx-sched-"));
});
afterEach(() => {
  rmSync(WS, { recursive: true, force: true });
});

/** Tiny PNG-ish payload — the controller writes bytes verbatim. */
function fakePng(seed = 0): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 0x89;
  b[1] = 0x50;
  b[2] = 0x4e;
  b[3] = 0x47;
  b[4] = seed & 0xff;
  return b;
}

/** Virtual clock — no real timers; sleeps advance `now` deterministically. */
function virtualClock(): ScheduleClock & { advance(ms: number): void } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms) => {
      t += Math.max(0, ms);
      return Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("validateScheduleArgs", () => {
  it.each([
    { name: "everyMs below the floor", args: { everyMs: 50, count: 2 }, error: /everyMs/ },
    { name: "everyMs above the ceiling", args: { everyMs: 60_001, count: 2 }, error: /everyMs/ },
    {
      name: "neither count nor durationMs supplied",
      args: { everyMs: 200 },
      error: /either `count`/,
    },
    {
      name: "both count and durationMs supplied (mutex)",
      args: { everyMs: 200, count: 3, durationMs: 1000 },
      error: /mutually exclusive/,
    },
    { name: "count below 1", args: { everyMs: 200, count: 0 }, error: /count/ },
    {
      name: "count above MAX_CAPTURES_PER_CALL",
      args: { everyMs: 200, count: MAX_CAPTURES_PER_CALL + 1 },
      error: /count/,
    },
    {
      name: "durationMs < everyMs (cadence couldn't fire even once)",
      args: { everyMs: 500, durationMs: 100 },
      error: /durationMs/,
    },
  ])("rejects $name", ({ args, error }) => {
    expect(() => validateScheduleArgs({ ...args, intoDir: "x" })).toThrow(error);
  });
});

describe("runSchedule — happy paths", () => {
  it("count-bounded: writes exactly N files holding the snap bytes, with matching paths/capturedAt", async () => {
    let i = 0;
    const snap: SnapFn = () => Promise.resolve(fakePng(i++));
    const clock = virtualClock();
    const r = await runSchedule(
      snap,
      {
        everyMs: 200,
        count: 3,
        intoDir: "shots/run-a",
      },
      WS,
      clock,
    );
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
    // the files hold the bytes the snap returned, in order
    expect(readFileSync(r.paths[0]!)[4]).toBe(0);
    expect(readFileSync(r.paths[2]!)[4]).toBe(2);
  });

  it("duration-bounded: stops when wall-clock exceeds durationMs", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const clock = virtualClock();
    const r = await runSchedule(
      snap,
      {
        everyMs: 200,
        durationMs: 700,
        intoDir: "shots/dur",
      },
      WS,
      clock,
    );
    // 0ms, 200ms, 400ms, 600ms → 4 captures; the next tick would land at 800ms.
    expect(r.count).toBe(4);
    expect(r.capturedAt.every((t) => t < 700)).toBe(true);
  });

  it("file extension follows the format", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const clock = virtualClock();
    const r = await runSchedule(
      snap,
      {
        everyMs: 200,
        count: 2,
        intoDir: "shots/fmt",
        format: "jpeg",
      },
      WS,
      clock,
    );
    for (const p of r.paths) expect(p.endsWith(".jpg")).toBe(true);
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
    const r = await runSchedule(
      snap,
      {
        everyMs: 200,
        count: 3,
        intoDir: "shots/err",
      },
      WS,
      clock,
    );
    expect(r.count).toBe(2); // 2 successful writes
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/transient renderer hiccup/);
  });

  it("rejects a path that escapes the workspace", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    await expect(
      runSchedule(
        snap,
        {
          everyMs: 200,
          count: 2,
          intoDir: "../escape",
        },
        WS,
        virtualClock(),
      ),
    ).rejects.toThrow(/\$BROWX_WORKSPACE/);
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
