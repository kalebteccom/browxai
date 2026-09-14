import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKPRESSURE_DROP_KEY, ReplayLog, readEventLog } from "./log.js";
import type { ReplayEvent } from "./schema.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "browx-replay-log-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function lines(path: string): ReplayEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as ReplayEvent);
}

/** A clock the test drives by hand, so `t` is asserted rather than tolerated. */
function fakeClock(start = 1000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
    rewind(ms: number) {
      value -= ms;
    },
  };
}

describe("ReplayLog — writing", () => {
  it("writes one JSON line per event under the workspace root", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "replays/s1/events.jsonl" });
    log.record("action/call", { tool: "click", args: { ref: "e1" } });
    log.record("console/message", { text: "hi" });
    const stats = await log.close();

    expect(stats.path).toBe(join(root, "replays/s1/events.jsonl"));
    expect(existsSync(stats.path)).toBe(true);
    const out = lines(stats.path);
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe("action/call");
    expect(out[1]?.payload).toEqual({ text: "hi" });
  });

  it("rejects a path that escapes the workspace root", async () => {
    await expect(
      ReplayLog.open({ workspaceRoot: root, path: "../outside/events.jsonl" }),
    ).rejects.toThrow(/must resolve inside \$BROWX_WORKSPACE/);
  });

  it("reports byte and event counts that match the file on disk", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl" });
    for (let i = 0; i < 50; i++) log.record("net/request", { url: `https://x/${i}`, i });
    const stats = await log.close();

    expect(stats.events).toBe(50);
    expect(stats.bytes).toBe(readFileSync(stats.path).byteLength);
  });

  it("counts events by type, which is what the manifest carries", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl" });
    log.record("action/call", {});
    log.record("action/call", {});
    log.record("assert/result", { ok: true });
    const stats = await log.close();

    expect(stats.counts).toEqual({ "action/call": 2, "assert/result": 1 });
  });

  it("carries targetId only when the caller supplies one", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl" });
    log.record("page/lifecycle", { name: "load" });
    log.record("page/lifecycle", { name: "load" }, { targetId: "T2" });
    const stats = await log.close();

    const out = lines(stats.path);
    expect(out[0]).not.toHaveProperty("targetId");
    expect(out[1]?.targetId).toBe("T2");
  });

  it("defaults the payload version to 1 and honours an override", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl" });
    log.record("dom/rrweb", {});
    log.record("dom/rrweb", {}, { v: 4 });
    const stats = await log.close();

    expect(lines(stats.path).map((e) => e.v)).toEqual([1, 4]);
  });
});

describe("ReplayLog — the clock", () => {
  it("makes t relative to the clock origin captured at start", async () => {
    const clock = fakeClock();
    const log = await ReplayLog.open({
      workspaceRoot: root,
      path: "e.jsonl",
      clockOrigin: 1_700_000_000_000,
      now: clock.now,
    });
    expect(log.clockOrigin).toBe(1_700_000_000_000);

    log.record("a", {});
    clock.advance(250);
    log.record("b", {});
    clock.advance(17);
    log.record("c", {});
    const stats = await log.close();

    expect(lines(stats.path).map((e) => e.t)).toEqual([0, 250, 267]);
  });

  it("never lets t go backwards when the source clock does", async () => {
    const clock = fakeClock();
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl", now: clock.now });
    clock.advance(500);
    log.record("a", {});
    clock.rewind(400);
    log.record("b", {});
    clock.advance(10);
    log.record("c", {});
    const stats = await log.close();

    const ts = lines(stats.path).map((e) => e.t);
    expect(ts).toEqual([500, 500, 500]);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1] as number);
  });

  it("defaults clockOrigin to wall-clock ms", async () => {
    const before = Date.now();
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl" });
    await log.close();
    expect(log.clockOrigin).toBeGreaterThanOrEqual(before);
    expect(log.clockOrigin).toBeLessThanOrEqual(Date.now());
  });
});

describe("ReplayLog — caps", () => {
  it("stops at the event cap, records the truncation and keeps the log valid", async () => {
    const clock = fakeClock();
    const log = await ReplayLog.open({
      workspaceRoot: root,
      path: "e.jsonl",
      maxEvents: 3,
      now: clock.now,
    });
    for (let i = 0; i < 10; i++) {
      clock.advance(5);
      log.record("net/request", { i });
    }
    const stats = await log.close();

    expect(stats.events).toBe(3);
    expect(stats.truncated).toEqual({ at: 20, reason: "event-cap", droppedEvents: 7 });
    // Valid means every line parses and the file ends on a newline.
    const text = readFileSync(stats.path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(lines(stats.path)).toHaveLength(3);
  });

  it("stops at the size cap without writing a partial line", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl", maxBytes: 200 });
    for (let i = 0; i < 100; i++) log.record("net/request", { pad: "x".repeat(40), i });
    const stats = await log.close();

    expect(stats.truncated?.reason).toBe("size-cap");
    expect(stats.bytes).toBeLessThanOrEqual(200);
    expect(() => lines(stats.path)).not.toThrow();
    expect(stats.truncated?.droppedEvents).toBe(100 - stats.events);
  });

  it("keeps recording when the caps are not reached", async () => {
    const log = await ReplayLog.open({
      workspaceRoot: root,
      path: "e.jsonl",
      maxEvents: 10,
      maxBytes: 1024 * 1024,
    });
    for (let i = 0; i < 10; i++) expect(log.record("a", { i })).toBe(true);
    const stats = await log.close();

    expect(stats.truncated).toBeUndefined();
    expect(stats.events).toBe(10);
  });

  it("records the cap breach once and counts every event after it", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl", maxEvents: 1 });
    log.record("a", {});
    expect(log.record("b", {})).toBe(false);
    expect(log.record("c", {})).toBe(false);
    expect(log.truncated?.droppedEvents).toBe(2);
    expect(log.truncated?.reason).toBe("event-cap");
    await log.close();
  });
});

describe("ReplayLog — backpressure", () => {
  it("record() is synchronous, so capture can never await the disk", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl" });
    const returned: unknown = log.record("a", {});
    expect(returned).toBe(true);
    expect(returned).not.toBeInstanceOf(Promise);
    await log.close();
  });

  it("drops events instead of growing the buffer when writes cannot keep up", async () => {
    const log = await ReplayLog.open({
      workspaceRoot: root,
      path: "e.jsonl",
      // Tiny in-memory window, never auto-flushed: the second event onward has
      // nowhere to go and must be dropped rather than buffered.
      maxPendingBytes: 120,
      flushBytes: 1024 * 1024,
      maxBytes: 1024 * 1024,
      maxEvents: 1000,
    });
    const accepted = [0, 1, 2, 3, 4, 5].map((i) => log.record("net/request", { i }));
    const stats = await log.close();

    const dropped = accepted.filter((a) => !a).length;
    expect(accepted).toContain(false);
    expect(stats.counts[BACKPRESSURE_DROP_KEY]).toBe(dropped);
    // A backpressure drop IS a truncation cause — the RFC pins the three-way
    // `size-cap` / `event-cap` / `backpressure` reason as load-bearing so the
    // player can render "why is the log short?" instead of surfacing silence.
    // Distinct from the two caps: backpressure does not stop capture, so the
    // event count reflects the accepted appends alongside the dropped ones.
    expect(stats.truncated?.reason).toBe("backpressure");
    expect(stats.truncated?.droppedEvents).toBe(dropped);
    expect(stats.events).toBe(accepted.filter(Boolean).length);
    expect(lines(stats.path)).toHaveLength(stats.events);
  });

  it("resumes recording once the in-flight window drains", async () => {
    const log = await ReplayLog.open({
      workspaceRoot: root,
      path: "e.jsonl",
      maxPendingBytes: 200,
      flushBytes: 1024 * 1024,
    });
    for (let i = 0; i < 20; i++) log.record("net/request", { pad: "y".repeat(30), i });
    const droppedEarly = log.counts[BACKPRESSURE_DROP_KEY] ?? 0;
    expect(droppedEarly).toBeGreaterThan(0);

    log.flush();
    await log.drained();
    expect(log.record("net/request", { late: true })).toBe(true);
    await log.close();
  });
});

describe("readEventLog", () => {
  it("round-trips the bytes the log wrote", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "replays/s/events.jsonl" });
    log.record("action/call", { tool: "navigate" });
    const stats = await log.close();

    const bytes = await readEventLog(root, "replays/s/events.jsonl");
    expect(bytes.byteLength).toBe(stats.bytes);
    expect(bytes.toString("utf8")).toBe(readFileSync(stats.path, "utf8"));
  });

  it("rejects a path outside the workspace root", async () => {
    await expect(readEventLog(root, "../escape.jsonl")).rejects.toThrow(
      /must resolve inside \$BROWX_WORKSPACE/,
    );
  });
});

describe("ReplayLog — close", () => {
  it("is idempotent and refuses further events", async () => {
    const log = await ReplayLog.open({ workspaceRoot: root, path: "e.jsonl" });
    log.record("a", {});
    const first = await log.close();
    expect(log.record("b", {})).toBe(false);
    const second = await log.close();
    expect(second).toEqual(first);
    expect(lines(first.path)).toHaveLength(1);
  });

  it("flushes a buffer that never reached the flush threshold", async () => {
    const log = await ReplayLog.open({
      workspaceRoot: root,
      path: "e.jsonl",
      flushBytes: 10 * 1024 * 1024,
    });
    log.record("a", { pad: "z".repeat(100) });
    expect(readFileSync(join(root, "e.jsonl"), "utf8")).toBe("");
    const stats = await log.close();
    expect(lines(stats.path)).toHaveLength(1);
  });
});
