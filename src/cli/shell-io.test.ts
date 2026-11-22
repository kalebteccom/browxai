import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { quietStream, writeAll } from "./shell-io.js";

/** A stream whose reader has gone: every write fails with EPIPE, as `| head -c1` leaves it. */
function closedPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    },
  });
}

describe("writeAll", () => {
  it("resolves once the text is written", async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c: Buffer) => chunks.push(c));
    await writeAll(sink, "one JSON document\n");
    expect(Buffer.concat(chunks).toString()).toBe("one JSON document\n");
  });

  it("resolves quietly when the reader has closed the pipe, with no uncaught error", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const pipe = closedPipe();
      await writeAll(pipe, "x".repeat(1000));
      // The error event is emitted on the next tick, after the write callback.
      await new Promise((r) => setImmediate(r));
      expect(uncaught).toEqual([]);
      expect(pipe.destroyed).toBe(true);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("keeps resolving for later writes to the same closed pipe", async () => {
    const pipe = closedPipe();
    await writeAll(pipe, "first");
    await expect(writeAll(pipe, "second")).resolves.toBeUndefined();
  });

  it("adds one quiet listener per stream however many writes follow", async () => {
    const sink = new PassThrough();
    sink.resume();
    for (let i = 0; i < 20; i++) await writeAll(sink, "line\n");
    expect(sink.listenerCount("error")).toBe(1);
    quietStream(sink);
    expect(sink.listenerCount("error")).toBe(1);
  });
});
