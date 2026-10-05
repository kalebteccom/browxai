import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ViewHub,
  type ViewFrame,
  type ViewHandle,
  type ViewSink,
  type ViewSource,
} from "./operator-view-hub.js";
import { MAX_STREAMS } from "./operator-view.js";

type Frame = Record<string, unknown>;

/** A frame source the test drives by hand. */
class FakeSource implements ViewSource {
  starts: Array<{ quality: number; maxWidth: number }> = [];
  stops = 0;
  acked = 0;
  failStart = false;
  #onFrame: ((f: ViewFrame) => void) | null = null;

  async start(
    picture: { quality: number; maxWidth: number },
    onFrame: (f: ViewFrame) => void,
  ): Promise<ViewHandle> {
    if (this.failStart) throw new Error("secret page title that must never leave");
    this.starts.push(picture);
    this.#onFrame = onFrame;
    return {
      stop: async () => {
        this.stops++;
        this.#onFrame = null;
      },
    };
  }

  get live(): boolean {
    return this.#onFrame !== null;
  }

  emit(data = "AAAA"): void {
    this.#onFrame?.({ data, ack: () => void this.acked++ });
  }
}

class FakeSink implements ViewSink {
  frames: Frame[] = [];
  writable = true;
  canWrite(): boolean {
    return this.writable;
  }
  send(frame: Frame): void {
    this.frames.push(frame);
  }
  of(type: string): Frame[] {
    return this.frames.filter((f) => f.type === type);
  }
}

let sink: FakeSink;
let hub: ViewHub;
let source: FakeSource;

/** Windows of 2 s in which a frame arrives every 250 ms and the daemon acks none:
 *  one goes out, the rest are dropped as slowness. */
async function slowWindows(n: number): Promise<void> {
  for (let i = 0; i < n * 8; i++) {
    source.emit();
    await vi.advanceTimersByTimeAsync(250);
  }
}

async function startView(extra: Frame = {}, session = "default"): Promise<void> {
  hub.handle({ type: "view.start", session, ...extra });
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  sink = new FakeSink();
  hub = new ViewHub(sink);
  source = new FakeSource();
  hub.register("default", source);
});

afterEach(() => {
  hub.stopAll("channel-closed");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ViewHub — start and stop", () => {
  it("starts the screencast at the defaults and tells the daemon what it got", async () => {
    await startView();
    expect(source.starts).toEqual([{ quality: 60, maxWidth: 960 }]);
    expect(sink.of("view.started")).toEqual([
      {
        type: "view.started",
        session: "default",
        format: "jpeg",
        maxFps: 5,
        maxWidth: 960,
        quality: 60,
      },
    ]);
  });

  it("clamps a request above the ceiling before it reaches the source", async () => {
    await startView({ maxFps: 30, maxWidth: 3000, quality: 100 });
    expect(source.starts).toEqual([{ quality: 80, maxWidth: 1280 }]);
    expect(sink.of("view.started")[0]).toMatchObject({ maxFps: 5, maxWidth: 1280, quality: 80 });
  });

  it("refuses by code: bad request, unknown session, engine with no source, too many streams", async () => {
    await startView({ maxFps: "fast" });
    await startView({}, "nobody");
    hub.register("native", null);
    await startView({}, "native");
    expect(sink.of("error").map((e) => [e.code, e.session])).toEqual([
      ["invalid-view", "default"],
      ["unknown-session", "nobody"],
      ["view-unsupported", "native"],
    ]);
    expect(source.starts).toEqual([]);

    for (let i = 0; i < MAX_STREAMS; i++) {
      hub.register(`s${i}`, new FakeSource());
      await startView({}, `s${i}`);
    }
    await startView({});
    expect(sink.of("error").pop()).toEqual({
      type: "error",
      code: "view-limit",
      session: "default",
    });
  });

  it("reports view-failed without the browser's message", async () => {
    source.failStart = true;
    await startView();
    expect(sink.frames).toEqual([{ type: "error", code: "view-failed", session: "default" }]);
    expect(JSON.stringify(sink.frames)).not.toContain("secret");
  });

  it("stops on the daemon's view.stop, and answers a stop for nothing the same way", async () => {
    await startView();
    hub.handle({ type: "view.stop", session: "default" });
    await vi.advanceTimersByTimeAsync(0);
    expect(source.stops).toBe(1);
    expect(sink.of("view.stopped")).toEqual([
      { type: "view.stopped", session: "default", reason: "daemon" },
    ]);
    hub.handle({ type: "view.stop", session: "default" });
    expect(sink.of("view.stopped")).toHaveLength(2);
  });

  it("replaces a running stream when the daemon starts the same session again", async () => {
    await startView({ maxWidth: 800 });
    await startView({ maxWidth: 640 });
    expect(source.stops).toBe(1);
    expect(source.starts.map((s) => s.maxWidth)).toEqual([800, 640]);
    expect(sink.of("view.stopped")).toEqual([]);
  });

  it("stops when the session closes, and refuses a start for it after", async () => {
    await startView();
    await hub.unregister("default");
    expect(source.stops).toBe(1);
    expect(sink.of("view.stopped")).toEqual([
      { type: "view.stopped", session: "default", reason: "session-closed" },
    ]);
    await startView();
    expect(sink.of("error").pop()).toMatchObject({ code: "unknown-session" });
  });

  it("stops every stream when the channel goes down, and never resumes on its own", async () => {
    await startView();
    hub.stopAll("channel-down");
    await vi.advanceTimersByTimeAsync(0);
    expect(source.stops).toBe(1);
    expect(source.live).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.starts).toHaveLength(1);
  });
});

describe("ViewHub — frames", () => {
  it("sends a frame with a sequence number, then holds the next until the daemon acks", async () => {
    await startView();
    source.emit("AAAA");
    expect(sink.of("frame")).toHaveLength(1);
    expect(sink.of("frame")[0]).toMatchObject({
      session: "default",
      seq: 1,
      format: "jpeg",
      part: 0,
      parts: 1,
      data: "AAAA",
    });
    await vi.advanceTimersByTimeAsync(400);
    source.emit("BBBB");
    expect(sink.of("frame")).toHaveLength(1);
    hub.handle({ type: "frame.ack", session: "default", seq: 1 });
    await vi.advanceTimersByTimeAsync(400);
    source.emit("CCCC");
    expect(sink.of("frame").map((f) => f.seq)).toEqual([1, 2]);
    expect(sink.of("frame")[1]!.data).toBe("CCCC");
  });

  it("holds a pair of frames close together to the frame rate", async () => {
    await startView({ maxFps: 5 });
    source.emit("AAAA");
    hub.handle({ type: "frame.ack", session: "default", seq: 1 });
    await vi.advanceTimersByTimeAsync(30);
    source.emit("BBBB");
    expect(sink.of("frame")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    source.emit("CCCC");
    expect(sink.of("frame").map((f) => f.data)).toEqual(["AAAA", "CCCC"]);
  });

  it("does not count a frame held to the rate as slowness", async () => {
    await startView({ maxFps: 5 });
    for (let w = 0; w < 6; w++) {
      source.emit("AAAA");
      hub.handle({ type: "frame.ack", session: "default", seq: sink.of("frame").length });
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(20);
        source.emit("BBBB");
      }
      await vi.advanceTimersByTimeAsync(1_900);
    }
    expect(source.starts).toHaveLength(1);
  });

  it("never queues: a burst with no ack leaves one frame on the wire", async () => {
    await startView();
    for (let i = 0; i < 200; i++) {
      source.emit("AAAA");
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(sink.of("frame")).toHaveLength(1);
  });

  it("ignores an ack for a sequence number it did not send, or for another session", async () => {
    await startView();
    source.emit();
    hub.handle({ type: "frame.ack", session: "default", seq: 99 });
    hub.handle({ type: "frame.ack", session: "other", seq: 1 });
    hub.handle({ type: "frame.ack", session: "default", seq: "1" });
    await vi.advanceTimersByTimeAsync(300);
    source.emit();
    expect(sink.of("frame")).toHaveLength(1);
  });

  it("drops a frame while the socket is backed up", async () => {
    await startView();
    sink.writable = false;
    source.emit();
    expect(sink.of("frame")).toHaveLength(0);
    sink.writable = true;
    await vi.advanceTimersByTimeAsync(300);
    source.emit();
    expect(sink.of("frame")).toHaveLength(1);
  });

  it("drops a frame too large for the parts allowed", async () => {
    await startView();
    source.emit("A".repeat(40_960 * 17));
    expect(sink.of("frame")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    source.emit("AAAA");
    expect(sink.of("frame")).toHaveLength(1);
  });

  it("cuts a large frame into parts that all carry its sequence number", async () => {
    await startView();
    source.emit("A".repeat(40_960 * 2 + 8));
    const parts = sink.of("frame");
    expect(parts.map((p) => [p.seq, p.part, p.parts])).toEqual([
      [1, 0, 3],
      [1, 1, 3],
      [1, 2, 3],
    ]);
  });

  it("treats a frame as lost after 5 s without an ack, and sends the next", async () => {
    await startView();
    source.emit();
    await vi.advanceTimersByTimeAsync(4_000);
    source.emit();
    expect(sink.of("frame")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    source.emit();
    expect(sink.of("frame")).toHaveLength(2);
  });

  it("stops a stream whose frames the daemon never acks, after 30 s", async () => {
    await startView();
    source.emit();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(sink.of("view.stopped")).toEqual([
      { type: "view.stopped", session: "default", reason: "stalled" },
    ]);
    expect(source.live).toBe(false);
  });
});

describe("ViewHub — the screencast's own flow control", () => {
  it("releases frames to the browser no faster than the stream rate", async () => {
    await startView({ maxFps: 5 });
    source.emit();
    source.emit();
    source.emit();
    // The first goes back at once. The others wait one interval each (200 ms).
    expect(source.acked).toBe(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(source.acked).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(source.acked).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(source.acked).toBe(3);
  });

  it("releases frames at the stepped-down rate after the daemon falls behind", async () => {
    await startView({ maxFps: 5, maxWidth: 960 });
    // Four windows of 2 s in which the daemon acks nothing step down the whole ladder.
    await slowWindows(4);
    expect(source.starts.at(-1)).toEqual({ quality: 60, maxWidth: 640 });
    expect(source.starts.length).toBeGreaterThan(1);
    // The emits above came faster than a browser would send them. Let the
    // releases they queued run out before measuring.
    hub.handle({ type: "frame.ack", session: "default", seq: sink.of("frame").length });
    await vi.advanceTimersByTimeAsync(15_000);
    const before = source.acked;
    source.emit();
    source.emit();
    expect(source.acked - before).toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(source.acked - before).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(source.acked - before).toBe(2);
  });

  it("restarts the screencast at a narrower width when it steps down, and keeps the quality", async () => {
    await startView({ quality: 45 });
    await slowWindows(1);
    expect(source.stops).toBe(1);
    expect(source.starts).toHaveLength(2);
    expect(source.starts[1]!.maxWidth).toBeLessThan(960);
    expect(source.starts[1]!.quality).toBe(45);
  });

  it("keeps the screencast running after a restart", async () => {
    await startView();
    await slowWindows(1);
    expect(source.live).toBe(true);
  });
});

describe("ViewHub — what leaves", () => {
  it("sends frame data only as frame parts, and never in an error or a stop", async () => {
    await startView();
    source.emit("PIXELS0123");
    await hub.unregister("default");
    for (const f of sink.frames) {
      if (f.type !== "frame") expect(JSON.stringify(f)).not.toContain("PIXELS");
    }
  });
});
