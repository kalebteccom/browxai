import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runScreenshotOn,
  validateOnArgs,
  defaultOnDir,
  TRIGGERS,
  MAX_TRIGGERS_PER_WINDOW,
  type SnapFn,
  type TriggerSource,
  type OnClock,
  type Trigger,
} from "./screenshot-on.js";

let WS: string;
beforeEach(() => { WS = mkdtempSync(join(tmpdir(), "browx-on-")); });
afterEach(() => { rmSync(WS, { recursive: true, force: true }); });

function fakePng(seed = 0): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[4] = seed & 0xff;
  return b;
}

/** Test source — exposes a `fire()` method so tests can deterministically
 *  push trigger events. The disposer is recorded so the test can assert the
 *  controller cleaned up. */
function makeSource(): TriggerSource & {
  fire: (t?: Trigger) => void;
  subscribedTo: Trigger | null;
  disposed: boolean;
} {
  let onFireCb: (() => void) | null = null;
  let subscribedTo: Trigger | null = null;
  let disposed = false;
  return {
    subscribe(trigger, onFire) {
      subscribedTo = trigger;
      onFireCb = onFire;
      return () => { disposed = true; onFireCb = null; };
    },
    get subscribedTo() { return subscribedTo; },
    get disposed() { return disposed; },
    fire() { if (onFireCb) onFireCb(); },
  } as TriggerSource & { fire: (t?: Trigger) => void; subscribedTo: Trigger | null; disposed: boolean };
}

/** Controllable clock: window-end timer is queued; the test calls `tick()`
 *  to run it. `setTimeout` for the drain is a real timer (10ms), kept short. */
function virtualClock(): OnClock & { advance(ms: number): void; runWindowEnd(): void } {
  let t = 1_000_000;
  let pendingEnd: { fn: () => void; at: number } | null = null;
  return {
    now: () => t,
    setTimeout(fn, ms) {
      pendingEnd = { fn, at: t + ms };
      return () => { pendingEnd = null; };
    },
    advance(ms) { t += ms; },
    runWindowEnd() {
      if (pendingEnd) {
        t = pendingEnd.at;
        const f = pendingEnd.fn;
        pendingEnd = null;
        f();
      }
    },
  };
}

describe("validateOnArgs", () => {
  it("rejects an unknown trigger", () => {
    expect(() => validateOnArgs({ trigger: "bogus" as unknown as Trigger, durationMs: 100, intoDir: "x" }))
      .toThrow(/trigger/);
  });
  it("rejects durationMs below the floor", () => {
    expect(() => validateOnArgs({ trigger: "navigation", durationMs: 0, intoDir: "x" }))
      .toThrow(/durationMs/);
  });
  it("rejects durationMs above the ceiling", () => {
    expect(() => validateOnArgs({ trigger: "navigation", durationMs: 600_001, intoDir: "x" }))
      .toThrow(/durationMs/);
  });
  it("accepts each of the four supported triggers", () => {
    for (const t of TRIGGERS) {
      expect(() => validateOnArgs({ trigger: t, durationMs: 100, intoDir: "x" })).not.toThrow();
    }
  });
});

describe("runScreenshotOn — happy path per trigger", () => {
  for (const trigger of TRIGGERS) {
    it(`captures on "${trigger}" fires inside the window`, async () => {
      const snap: SnapFn = () => Promise.resolve(fakePng());
      const source = makeSource();
      const clock = virtualClock();
      const p = runScreenshotOn(snap, source, {
        trigger, durationMs: 1000, intoDir: `evt/${trigger}`,
      }, WS, clock);
      // settle subscription
      await new Promise((r) => setImmediate(r));
      expect(source.subscribedTo).toBe(trigger);
      source.fire();
      source.fire();
      // let the in-flight snap promises settle
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      clock.runWindowEnd();
      const r = await p;
      expect(r.trigger).toBe(trigger);
      expect(r.paths.length).toBeGreaterThanOrEqual(1);
      expect(source.disposed).toBe(true);
      for (const fp of r.paths) expect(existsSync(fp)).toBe(true);
    });
  }
});

describe("runScreenshotOn — bounded & safe", () => {
  it("returns with zero captures when nothing fires inside the window", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const source = makeSource();
    const clock = virtualClock();
    const p = runScreenshotOn(snap, source, {
      trigger: "navigation", durationMs: 500, intoDir: "evt/silent",
    }, WS, clock);
    await new Promise((r) => setImmediate(r));
    clock.runWindowEnd();
    const r = await p;
    expect(r.paths).toEqual([]);
    expect(r.capturedAt).toEqual([]);
    expect(source.disposed).toBe(true);
  });

  it("enforces MAX_TRIGGERS_PER_WINDOW and surfaces a warning when reached", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const source = makeSource();
    const clock = virtualClock();
    const p = runScreenshotOn(snap, source, {
      trigger: "console-error", durationMs: 5000, intoDir: "evt/storm",
    }, WS, clock);
    await new Promise((r) => setImmediate(r));
    // Drive the trigger one-at-a-time and yield between fires so the snap
    // settles (otherwise the in-flight `snapping` guard drops them).
    for (let i = 0; i < MAX_TRIGGERS_PER_WINDOW + 25; i++) {
      source.fire();
      // microtask + macrotask yield so the synchronous writeFileSync inside
      // the snap-resolution finishes and `snapping` resets to false.
      await new Promise((r) => setImmediate(r));
    }
    const r = await p;
    expect(r.paths.length).toBe(MAX_TRIGGERS_PER_WINDOW);
    expect(r.warnings.some((w) => /MAX_TRIGGERS_PER_WINDOW/.test(w))).toBe(true);
    expect(source.disposed).toBe(true);
  });

  it("rejects a path that escapes the workspace", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const source = makeSource();
    await expect(runScreenshotOn(snap, source, {
      trigger: "navigation", durationMs: 100, intoDir: "../escape",
    }, WS, virtualClock())).rejects.toThrow(/\$BROWX_WORKSPACE/);
  });

  it("surfaces snap errors as warnings (window still closes cleanly)", async () => {
    let n = 0;
    const snap: SnapFn = () => {
      const i = n++;
      if (i === 0) return Promise.reject(new Error("snap fail"));
      return Promise.resolve(fakePng(i));
    };
    const source = makeSource();
    const clock = virtualClock();
    const p = runScreenshotOn(snap, source, {
      trigger: "dialog", durationMs: 1000, intoDir: "evt/err",
    }, WS, clock);
    await new Promise((r) => setImmediate(r));
    source.fire();
    await new Promise((r) => setImmediate(r));
    source.fire();
    await new Promise((r) => setImmediate(r));
    clock.runWindowEnd();
    const r = await p;
    expect(r.warnings.some((w) => /snap fail/.test(w))).toBe(true);
    expect(r.paths.length).toBe(1);                     // 1 success
  });

  it("disposes the trigger subscription on every exit path", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const source = makeSource();
    const clock = virtualClock();
    const p = runScreenshotOn(snap, source, {
      trigger: "network-mutation", durationMs: 300, intoDir: "evt/dispose",
    }, WS, clock);
    await new Promise((r) => setImmediate(r));
    clock.runWindowEnd();
    await p;
    expect(source.disposed).toBe(true);
  });

  it("creates a nested intoDir if missing", async () => {
    const snap: SnapFn = () => Promise.resolve(fakePng());
    const source = makeSource();
    const clock = virtualClock();
    const p = runScreenshotOn(snap, source, {
      trigger: "navigation", durationMs: 100, intoDir: "deep/nested/evt",
    }, WS, clock);
    await new Promise((r) => setImmediate(r));
    clock.runWindowEnd();
    const r = await p;
    expect(existsSync(join(WS, "deep/nested/evt"))).toBe(true);
    expect(readdirSync(r.intoDir).length).toBe(0);
  });
});

describe("defaultOnDir", () => {
  it("uses a filesystem-friendly ISO timestamp", () => {
    const d = defaultOnDir("sess-X", new Date("2026-06-08T12:34:56.789Z"));
    expect(d).toBe("screenshots/sess-X-2026-06-08T12-34-56-789Z");
    expect(d.includes(":")).toBe(false);
    expect(d.includes(".")).toBe(false);
  });
});
