// Unit coverage for the player's pure half (RFC 0007 P2): the timeline model,
// step indexing, jump-to-failure, the browser-side artifact reader and the
// rrweb envelope adapter. The rendering half is covered by
// test/keystone/replay-player.keystone.test.ts, which opens the BUILT file in a
// real browser — a jsdom assertion about innerHTML would prove nothing about
// whether the replay actually renders.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { writeArtifact, zipBuild, sha256 } from "./artifact.js";
import type { ReplayEvent, ReplayManifest } from "./schema.js";
import {
  buildTimeline,
  findFirstFailure,
  healthOf,
  idleAt,
  stepIndexAt,
  DEFAULT_IDLE_GAP_MS,
} from "./player/model.js";
import {
  openArtifact,
  parseEventLine,
  readCentralDirectory,
  ArtifactOpenError,
} from "./player/artifact-open.js";
import {
  domPayloads,
  isPlayable,
  ReplayStage,
  type RrwebGlobal,
  type RrwebMeta,
} from "./player/replay-stage.js";

const CLOCK_ORIGIN = 1_700_000_000_000;

function ev(t: number, type: string, payload: unknown, v = 1): ReplayEvent {
  return { t, type, v, payload };
}

function rrweb(t: number, rrwebType: number): ReplayEvent {
  return ev(t, "dom/rrweb", { type: rrwebType, timestamp: CLOCK_ORIGIN + t, data: {} });
}

/** A realistic log: two actions, a passing assertion, a failing one, an
 *  annotation span, a DOM stream, and one event type this build has never
 *  heard of. */
function sampleEvents(): ReplayEvent[] {
  return [
    rrweb(0, 4),
    rrweb(5, 2),
    ev(10, "annotate/span", { label: "AC-1", phase: "start", note: "checkout" }),
    ev(20, "action/call", { tool: "navigate", args: { url: "https://example.test/" } }),
    ev(60, "action/result", { tool: "navigate", ok: true }),
    rrweb(70, 3),
    ev(100, "action/call", { tool: "fill", args: { value: "x" } }),
    ev(140, "action/result", { tool: "fill", ok: false, error: "element detached" }),
    ev(150, "action/call", { tool: "verify_text", args: { text: "Saved" } }),
    ev(180, "assert/result", { tool: "verify_text", ok: true }),
    ev(200, "action/call", { tool: "verify_visible", args: {} }),
    ev(240, "assert/result", {
      tool: "verify_visible",
      ok: false,
      expected: "visible",
      actual: "hidden",
      failure: { kind: "not-visible", expected: "visible", actual: "hidden" },
    }),
    ev(250, "annotate/span", { label: "AC-1", phase: "end" }),
    ev(260, "console/message", { type: "error", text: "boom" }),
    // The forward-compatibility case: a type from a browxai that does not exist
    // yet, carrying a payload shape this build cannot interpret.
    ev(270, "telemetry/flamechart", { frames: [1, 2, 3], nested: { deep: true } }, 7),
    ev(280, "framework/redux-action", { type: "cart/add" }),
  ];
}

describe("player timeline model", () => {
  it("pairs each call with its result and derives before/after from the pair", () => {
    const model = buildTimeline(sampleEvents());
    expect(model.steps.map((s) => s.tool)).toEqual([
      "navigate",
      "fill",
      "verify_text",
      "verify_visible",
    ]);
    const [navigate, fill] = model.steps;
    expect(navigate).toMatchObject({ kind: "action", ok: true, before: 20, after: 60 });
    expect(fill).toMatchObject({ kind: "action", ok: false, before: 100, after: 140 });
    expect(model.steps[3]).toMatchObject({
      kind: "assert",
      ok: false,
      before: 200,
      after: 240,
      expected: "visible",
      actual: "hidden",
    });
    expect(model.duration).toBe(280);
    expect(model.domEventCount).toBe(3);
  });

  it("leaves a call with no result as a step with no verdict", () => {
    const model = buildTimeline([
      ev(0, "action/call", { tool: "click" }),
      ev(10, "action/call", { tool: "wait_for" }),
      ev(50, "action/result", { tool: "wait_for", ok: true }),
    ]);
    // Only the resulted tool becomes a step; the orphan click is simply not
    // marked as having succeeded, which is the honest reading of the log.
    expect(model.steps).toHaveLength(1);
    expect(model.steps[0]).toMatchObject({ tool: "wait_for", ok: true, before: 10 });
  });

  it("marks each step on the timeline with the kind the strip colours by", () => {
    const model = buildTimeline(sampleEvents());
    const kinds = model.markers.filter((m) => m.kind !== "unknown").map((m) => m.kind);
    expect(kinds).toEqual(["action", "action-failed", "assert-pass", "assert-fail"]);
  });

  it("closes annotation spans on their end phase and runs an open span to the end", () => {
    const model = buildTimeline(sampleEvents());
    expect(model.spans).toEqual([
      { label: "AC-1", from: 10, to: 250, open: false, note: "checkout" },
    ]);

    const open = buildTimeline([
      ev(0, "annotate/span", { label: "AC-9", phase: "start" }),
      ev(900, "console/message", { type: "log", text: "still going" }),
    ]);
    expect(open.spans[0]).toMatchObject({ label: "AC-9", from: 0, to: 900, open: true });
  });

  it("finds the dead air between events so playback can skip it", () => {
    const gap = DEFAULT_IDLE_GAP_MS + 500;
    const model = buildTimeline([ev(0, "console/message", {}), ev(gap, "console/message", {})]);
    expect(model.idle).toEqual([{ from: 0, to: gap }]);
    expect(idleAt(model, 100)).toEqual({ from: 0, to: gap });
    expect(idleAt(model, gap)).toBeUndefined();
  });

  it("resolves the playhead to the step it is inside", () => {
    const model = buildTimeline(sampleEvents());
    expect(stepIndexAt(model, 0)).toBe(-1);
    expect(stepIndexAt(model, 30)).toBe(0);
    expect(stepIndexAt(model, 145)).toBe(1);
    expect(stepIndexAt(model, 10_000)).toBe(3);
  });
});

describe("jump to failure", () => {
  it("prefers the first failed assertion over an earlier failed action", () => {
    const model = buildTimeline(sampleEvents());
    // `fill` failed at t=140, the assertion at t=240. The assertion is the
    // reviewer's acceptance criterion; an action failure is often a retry.
    expect(findFirstFailure(model)).toMatchObject({ tool: "verify_visible", after: 240 });
  });

  it("falls back to the first failed action when nothing asserted", () => {
    const model = buildTimeline([
      ev(0, "action/call", { tool: "click" }),
      ev(10, "action/result", { tool: "click", ok: true }),
      ev(20, "action/call", { tool: "fill" }),
      ev(30, "action/result", { tool: "fill", ok: false, error: "gone" }),
    ]);
    expect(findFirstFailure(model)).toMatchObject({ tool: "fill", error: "gone" });
  });

  it("reports nothing on a clean run", () => {
    const model = buildTimeline([
      ev(0, "action/call", { tool: "click" }),
      ev(10, "action/result", { tool: "click", ok: true }),
    ]);
    expect(findFirstFailure(model)).toBeUndefined();
  });
});

describe("forward compatibility — an unknown event type", () => {
  it("becomes an unknown marker and never a step, a span or a DOM event", () => {
    const model = buildTimeline(sampleEvents());
    expect(model.unknownTypes).toEqual([{ type: "telemetry/flamechart", count: 1, firstT: 270 }]);
    const unknown = model.markers.filter((m) => m.kind === "unknown");
    expect(unknown).toEqual([{ t: 270, kind: "unknown", label: "telemetry/flamechart" }]);
    expect(model.steps.some((s) => s.tool.includes("flamechart"))).toBe(false);
  });

  it("does not block playback: the DOM stream and the step list are untouched", () => {
    const withUnknown = buildTimeline(sampleEvents());
    const without = buildTimeline(sampleEvents().filter((e) => e.type !== "telemetry/flamechart"));
    expect(withUnknown.steps).toEqual(without.steps);
    expect(domPayloads(sampleEvents())).toHaveLength(3);
  });

  it("leaves a known type this build DOES know but ships no panel for out of the unknown set", () => {
    // `framework/redux-action` is in the schema's union with no v1 panel. It is
    // known, so it must not be reported as "recorded by a newer browxai".
    const model = buildTimeline(sampleEvents());
    expect(model.unknownTypes.map((u) => u.type)).not.toContain("framework/redux-action");
    expect(model.counts["framework/redux-action"]).toBe(1);
  });

  it("survives a known type whose payload is the wrong shape entirely", () => {
    const model = buildTimeline([
      ev(0, "action/result", "not-an-object"),
      ev(10, "assert/result", null),
      ev(20, "annotate/span", 42),
      ev(30, "dom/rrweb", undefined),
      { t: 40, type: "action/call", v: 1, payload: { tool: 99 } },
    ]);
    expect(model.steps.map((s) => s.tool)).toEqual(["(unnamed)", "(unnamed)"]);
    expect(model.steps.every((s) => s.ok === undefined)).toBe(true);
    expect(model.spans).toEqual([]);
  });

  it("keeps a negative or non-numeric t from corrupting the timeline", () => {
    const model = buildTimeline([
      { t: -50, type: "console/message", v: 1, payload: {} },
      { t: Number.NaN, type: "console/message", v: 1, payload: {} },
      ev(120, "console/message", {}),
    ]);
    expect(model.duration).toBe(120);
    expect(model.idle).toEqual([]);
  });
});

describe("health reporting", () => {
  const manifest = (extra: Partial<ReplayManifest> = {}): ReplayManifest => ({
    schemaVersion: 1,
    sessionId: "s",
    clockOrigin: CLOCK_ORIGIN,
    tier: "replay",
    browxaiVersion: "0.10.0",
    engine: "chromium",
    counts: {},
    eventsDigest: "deadbeef",
    ...extra,
  });

  it("carries truncation through verbatim — the player must say it out loud", () => {
    const cut = { at: 900, reason: "size-cap" as const, droppedEvents: 412 };
    const health = healthOf(manifest({ truncated: cut }), buildTimeline(sampleEvents()), true);
    expect(health.truncated).toEqual(cut);
  });

  it("reports no truncation as absent, not as zero", () => {
    const health = healthOf(manifest(), buildTimeline([]), true);
    expect(health.truncated).toBeUndefined();
    expect("truncated" in health).toBe(false);
  });

  it("surfaces malformed lines and an unverified digest", () => {
    const model = buildTimeline(sampleEvents(), { malformed: 3 });
    const health = healthOf(manifest(), model, undefined);
    expect(health.malformed).toBe(3);
    expect(health.digestVerified).toBeUndefined();
    expect(health.unknownTypes).toHaveLength(1);
  });
});

describe("browser-side artifact reader", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "browx-player-"));
  });
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const write = async (
    events: readonly ReplayEvent[],
    extra: Partial<ReplayManifest> = {},
    name = "replay",
  ): Promise<Uint8Array> => {
    const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const res = await writeArtifact({
      workspaceRoot: workspace,
      path: `${name}.browx`,
      manifest: {
        schemaVersion: 1,
        sessionId: "session-under-test",
        clockOrigin: CLOCK_ORIGIN,
        tier: "replay",
        browxaiVersion: "0.10.0",
        engine: "chromium",
        counts: {},
        ...extra,
      },
      events: jsonl,
    });
    return await readFile(res.path);
  };

  it("opens an artifact the Node writer produced and verifies the digest", async () => {
    const bytes = await write(sampleEvents());
    const opened = await openArtifact(bytes);
    expect(opened.manifest.sessionId).toBe("session-under-test");
    expect(opened.digestVerified).toBe(true);
    expect(opened.events).toHaveLength(sampleEvents().length);
    expect(opened.malformed).toBe(0);
    expect(opened.events[0]).toMatchObject({ type: "dom/rrweb", t: 0 });
  });

  it("reports progress and yields while it parses, instead of blocking on one parse", async () => {
    const many = Array.from({ length: 4000 }, (_, i) =>
      ev(i, "console/message", { text: `n${i}` }),
    );
    const bytes = await write(many, {}, "many");
    const phases: string[] = [];
    const opened = await openArtifact(bytes, { onProgress: (p) => phases.push(p.phase) });
    expect(opened.events).toHaveLength(4000);
    expect(phases[0]).toBe("directory");
    expect(phases).toContain("events");
    expect(phases.at(-1)).toBe("done");
  });

  it("keeps unknown envelope AND payload fields through the round trip", async () => {
    const bytes = await write(
      [{ t: 5, type: "telemetry/flamechart", v: 9, payload: { a: 1 }, targetId: "T1" }],
      {},
      "fwd",
    );
    const opened = await openArtifact(bytes);
    expect(opened.events[0]).toEqual({
      t: 5,
      type: "telemetry/flamechart",
      v: 9,
      payload: { a: 1 },
      targetId: "T1",
    });
  });

  it("counts an unparseable line instead of failing to open the log", async () => {
    const jsonl = `{"t":0,"type":"console/message","v":1,"payload":{}}\n{ this is not json\n[]\n`;
    const res = await writeArtifact({
      workspaceRoot: workspace,
      path: "broken.browx",
      manifest: {
        schemaVersion: 1,
        sessionId: "broken",
        clockOrigin: CLOCK_ORIGIN,
        tier: "actions",
        browxaiVersion: "0.10.0",
        engine: "chromium",
        counts: {},
      },
      events: jsonl,
    });
    const opened = await openArtifact(await readFile(res.path));
    expect(opened.events).toHaveLength(1);
    expect(opened.malformed).toBe(2);
  });

  it("says the digest is unverified rather than implying it checked", async () => {
    const bytes = await write(sampleEvents(), {}, "nohash");
    const opened = await openArtifact(bytes, { digestLimit: 1 });
    expect(opened.digestVerified).toBeUndefined();
  });

  it("reports a digest mismatch as false, not as a thrown open", async () => {
    const events = `{"t":0,"type":"console/message","v":1,"payload":{}}\n`;
    const zip = zipBuild([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            sessionId: "tampered",
            clockOrigin: CLOCK_ORIGIN,
            tier: "actions",
            browxaiVersion: "0.10.0",
            engine: "chromium",
            counts: {},
            eventsDigest: sha256(Buffer.from("something else")),
          }),
        ),
      },
      { name: "events.jsonl.gz", data: gzipSync(Buffer.from(events)) },
    ]);
    const opened = await openArtifact(zip);
    expect(opened.digestVerified).toBe(false);
    expect(opened.events).toHaveLength(1);
  });

  it("refuses a file that is not a zip, with a message that says why", async () => {
    await expect(openArtifact(new Uint8Array(64))).rejects.toBeInstanceOf(ArtifactOpenError);
  });

  it("walks the central directory without inflating the bodies", async () => {
    const bytes = await write(sampleEvents(), {}, "dir");
    const entries = readCentralDirectory(bytes);
    expect([...entries.keys()]).toEqual(["manifest.json", "events.jsonl.gz"]);
    expect(entries.get("manifest.json")?.size).toBeGreaterThan(0);
  });
});

describe("rrweb envelope adapter", () => {
  it("hands rrweb the payload, not the browxai envelope", () => {
    const payloads = domPayloads(sampleEvents());
    expect(payloads).toHaveLength(3);
    for (const p of payloads) {
      expect(p).not.toHaveProperty("payload");
      expect(typeof p.type).toBe("number");
    }
  });

  it("skips a dom/rrweb event whose payload is not an object", () => {
    expect(domPayloads([ev(0, "dom/rrweb", null), ev(1, "dom/rrweb", "nope")])).toEqual([]);
  });

  it("calls a stream without a meta event or a full snapshot unplayable", () => {
    expect(isPlayable([])).toBe(false);
    expect(isPlayable([{ type: 4 }])).toBe(false);
    expect(isPlayable([{ type: 4 }, { type: 3 }])).toBe(false);
    expect(isPlayable([{ type: 4 }, { type: 2 }])).toBe(true);
  });

  it("returns no stage for a log with no DOM stream, instead of throwing", () => {
    const events = [ev(0, "console/message", { text: "only console here" })];
    const stage = ReplayStage.create(events, {
      root: {} as never,
      clockOrigin: CLOCK_ORIGIN,
      rrweb: stubRrweb({ startTime: 0, endTime: 0, totalTime: 0 }),
    });
    expect(stage).toBeUndefined();
  });

  it("translates browxai timeline ms into rrweb's offset from its first event", () => {
    const meta: RrwebMeta = {
      startTime: CLOCK_ORIGIN + 100,
      endTime: CLOCK_ORIGIN + 1100,
      totalTime: 1000,
    };
    const stage = ReplayStage.create(sampleEvents(), {
      root: {} as never,
      clockOrigin: CLOCK_ORIGIN,
      rrweb: stubRrweb(meta),
    });
    expect(stage).toBeDefined();
    // t=0 is before the DOM stream starts, so it clamps to the first frame.
    expect(stage?.offsetFor(0)).toBe(0);
    expect(stage?.offsetFor(600)).toBe(500);
    expect(stage?.offsetFor(999_999)).toBe(1000);
    expect(stage?.coverage()).toEqual({ from: 100, to: 1100 });
    stage?.destroy();
  });

  it("seeks one millisecond past the requested time so the event AT it is applied", () => {
    // rrweb applies an event synchronously only when `timestamp < baselineTime`
    // and hands anything landing exactly on the baseline to the playback timer,
    // which a seek then clears. Without the +1 the opening frame is an empty
    // iframe with the meta + full snapshot still queued.
    const stage = ReplayStage.create(sampleEvents(), {
      root: {} as never,
      clockOrigin: CLOCK_ORIGIN,
      rrweb: stubRrweb({
        startTime: CLOCK_ORIGIN,
        endTime: CLOCK_ORIGIN + 500,
        totalTime: 500,
      }),
    });
    expect(stage?.seekOffsetFor(0)).toBe(1);
    expect(stage?.seekOffsetFor(240)).toBe(241);
    // Unclamped at the top: past the end means "apply everything", which is the
    // correct final frame.
    expect(stage?.seekOffsetFor(10_000)).toBe(10_001);
    stage?.destroy();
  });
});

function stubRrweb(meta: RrwebMeta): RrwebGlobal {
  return {
    Replayer: class {
      constructor(
        public events: unknown[],
        public config?: Record<string, unknown>,
      ) {}
      play(): void {}
      pause(): void {}
      destroy(): void {}
      setConfig(): void {}
      getMetaData(): RrwebMeta {
        return meta;
      }
      getCurrentTime(): number {
        return 0;
      }
      on(): unknown {
        return this;
      }
    },
  };
}

describe("line parsing agrees with the Node reader", () => {
  it("defaults a missing envelope field instead of dropping the line", () => {
    expect(parseEventLine('{"payload":{"a":1}}')).toEqual({
      t: 0,
      type: "unknown",
      v: 0,
      payload: { a: 1 },
    });
  });

  it("rejects a non-object line", () => {
    expect(parseEventLine("[]")).toBeUndefined();
    expect(parseEventLine("null")).toBeUndefined();
    expect(parseEventLine("{oops")).toBeUndefined();
  });
});
