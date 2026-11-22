import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { quietStream, settle, streamIo, writeAll, type ShellIo } from "./shell-io.js";
import { runTools } from "./shell-tools.js";

/** A stream whose reader has gone: every write fails with EPIPE, as `| head -c1` leaves it. */
function closedPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    },
  });
}

/** A stream that fails every write with the given error code, as a full disk does with ENOSPC. */
function failingStream(code: string): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error(`write ${code}`), { code }));
    },
  });
}

/** Two streams for `streamIo`: standard error collects what it is given. */
function ioOver(stdout: Writable) {
  const stderr = new PassThrough();
  const seen: string[] = [];
  stderr.on("data", (c: Buffer) => seen.push(c.toString()));
  const io: ShellIo = streamIo(stdout, stderr, {
    env: {},
    input: { readStdin: () => Promise.resolve(""), readFile: () => "" },
  });
  return { io, stderr: () => seen.join("") };
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

describe("write failures other than a closed pipe", () => {
  it("writeAll returns the failure, with no uncaught error", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const failure = await writeAll(failingStream("ENOSPC"), "x");
      await new Promise((r) => setImmediate(r));
      expect(failure?.code).toBe("ENOSPC");
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("returns nothing for a closed pipe, and for the writes that follow it", async () => {
    const pipe = closedPipe();
    expect(await writeAll(pipe, "first")).toBeUndefined();
    expect(await writeAll(pipe, "second")).toBeUndefined();
  });

  it("makes a command that printed its result to a full disk exit 1 with a stderr line", async () => {
    const { io, stderr } = ioOver(failingStream("ENOSPC"));
    expect(await runTools(["--json"], io)).toBe(1);
    expect(stderr()).toContain("could not write the result to standard output (ENOSPC)");
  });

  it("makes an I/O error on standard output exit 1 as well", async () => {
    const { io, stderr } = ioOver(failingStream("EIO"));
    expect(await runTools(["--json"], io)).toBe(1);
    expect(stderr()).toContain("(EIO)");
  });

  it("lets a command exit with the code it computed when the reader closed the pipe", async () => {
    const { io, stderr } = ioOver(closedPipe());
    expect(await runTools(["--json"], io)).toBe(0);
    expect(stderr()).not.toContain("could not write the result");
    expect(io.writeFailure?.()).toBeUndefined();
  });

  it("keeps a non-zero code the command already had", async () => {
    const { io, stderr } = ioOver(failingStream("ENOSPC"));
    await io.stdout("x");
    expect(await settle(io, 3)).toBe(3);
    expect(stderr()).toContain("ENOSPC");
  });

  it("changes nothing when every write worked", async () => {
    const stdout = new PassThrough();
    stdout.resume();
    const { io, stderr } = ioOver(stdout);
    await io.stdout("ok");
    expect(await settle(io, 0)).toBe(0);
    expect(stderr()).toBe("");
  });
});
