import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SendQueue } from "./bridge-queue.js";

const message = (id: number, pad = ""): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  method: "ping",
  params: { pad },
});

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("SendQueue", () => {
  it("writes one message at a time, in the order they were pushed", async () => {
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const queue = new SendQueue({
      send: (m) => {
        started.push((m as { id: number }).id);
        return new Promise<void>((resolve) => finish.push(resolve));
      },
      highWaterBytes: 1_000_000,
      onError: () => undefined,
    });
    queue.push(message(1));
    queue.push(message(2));
    await turn();
    expect(started).toEqual([1]);
    finish[0]!();
    await turn();
    expect(started).toEqual([1, 2]);
    finish[1]!();
    await queue.idle();
    expect(queue.paused).toBe(false);
  });

  it("reports a failed write and carries on with the next message", async () => {
    const errors: unknown[] = [];
    const sent: number[] = [];
    const queue = new SendQueue({
      send: (m) => {
        const id = (m as { id: number }).id;
        if (id === 1) return Promise.reject(new Error("write failed"));
        sent.push(id);
        return Promise.resolve();
      },
      highWaterBytes: 1_000_000,
      onError: (err) => errors.push(err),
    });
    queue.push(message(1));
    queue.push(message(2));
    await queue.idle();
    expect(errors).toHaveLength(1);
    expect(sent).toEqual([2]);
  });

  it("drops what is still queued when it is disposed, and resumes a paused source", async () => {
    const flow: string[] = [];
    const sent: number[] = [];
    let release: () => void = () => undefined;
    const queue = new SendQueue({
      send: (m) => {
        sent.push((m as { id: number }).id);
        return new Promise<void>((resolve) => (release = resolve));
      },
      flow: { pause: () => flow.push("pause"), resume: () => flow.push("resume") },
      highWaterBytes: 50,
      onError: () => undefined,
    });
    queue.push(message(1));
    queue.push(message(2, "x".repeat(100)));
    await turn();
    expect(queue.paused).toBe(true);
    queue.dispose();
    expect(flow).toEqual(["pause", "resume"]);
    release();
    await queue.idle();
    queue.push(message(3));
    await queue.idle();
    expect(sent).toEqual([1]);
  });
});
