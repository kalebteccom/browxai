// The live view as the operator channel wires it: the capability gate, and a
// stream over a real Unix socket to a stand-in daemon, fed by a source the test
// drives by hand. The browser end is in test/keystone/live-view.keystone.test.ts.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { openOperatorChannel, type OperatorChannel } from "./operator-channel.js";
import type { ViewFrame, ViewHandle, ViewSource } from "./operator-view-hub.js";
import { startFakeDaemon, type FakeDaemon } from "./__fixtures__/operator-daemon.js";
import { resolveCapabilities } from "../util/capabilities.js";
import "../tools/tool-metadata.js";

const BASE = "read,navigation,action,human";
const CHANNEL_ONLY = resolveCapabilities({ BROWX_CAPABILITIES: `${BASE},operator-channel` });
const BOTH = resolveCapabilities({ BROWX_CAPABILITIES: `${BASE},operator-channel,live-view` });
const VIEW_ONLY = resolveCapabilities({ BROWX_CAPABILITIES: `${BASE},live-view` });

class FakeSource implements ViewSource {
  starts = 0;
  stops = 0;
  #onFrame: ((f: ViewFrame) => void) | null = null;
  async start(_p: unknown, onFrame: (f: ViewFrame) => void): Promise<ViewHandle> {
    this.starts++;
    this.#onFrame = onFrame;
    return {
      stop: async () => {
        this.stops++;
        this.#onFrame = null;
      },
    };
  }
  emit(data: string): void {
    this.#onFrame?.({ data, ack: () => undefined });
  }
}

let daemon: FakeDaemon;
let channel: OperatorChannel | null = null;

function open(caps = BOTH): OperatorChannel {
  channel = openOperatorChannel(caps, {
    BROWX_OPERATOR_SOCKET: daemon.socketPath,
    BROWX_OPERATOR_TOKEN: daemon.token,
  });
  if (!channel) throw new Error("the channel did not open");
  return channel;
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const frames = (type: string) => daemon.frames.filter((f) => f.type === type);

beforeEach(async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  daemon = await startFakeDaemon();
});

afterEach(async () => {
  channel?.close();
  channel = null;
  await daemon.close();
  vi.restoreAllMocks();
});

describe("live-view — the gate", () => {
  it("refuses to start without operator-channel, and names neither the path nor the token", () => {
    const env = { BROWX_OPERATOR_SOCKET: daemon.socketPath, BROWX_OPERATOR_TOKEN: daemon.token };
    let message = "";
    try {
      openOperatorChannel(VIEW_ONLY, env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("live-view");
    expect(message).toContain("operator-channel");
    expect(message).not.toContain(daemon.socketPath);
    expect(message).not.toContain(daemon.token);
    // The variables were still taken out of the environment.
    expect(env).toEqual({});
  });

  it("hands out no view registry unless the capability is on", () => {
    expect(open(CHANNEL_ONLY).liveView).toBeUndefined();
    channel!.close();
    daemon.frames.length = 0;
    expect(open(BOTH).liveView).toBeDefined();
  });

  it("answers view.start with view-disabled when the capability is off, and starts nothing", async () => {
    open(CHANNEL_ONLY);
    await until(() => daemon.authenticated === 1);
    daemon.send({ type: "view.start", session: "default" });
    daemon.send({ type: "view.stop", session: "default" });
    daemon.send({ type: "frame.ack", session: "default", seq: 1 });
    await until(() => frames("error").length === 1);
    expect(frames("error")[0]).toMatchObject({ code: "view-disabled", session: "default" });
    await new Promise((r) => setTimeout(r, 150));
    expect(frames("view.started")).toEqual([]);
    expect(frames("error")).toHaveLength(1);
  });
});

describe("live-view — a stream over the socket", () => {
  it("streams frames to the daemon after view.start, and stops on view.stop", async () => {
    const source = new FakeSource();
    open().liveView!.register("default", source);
    await until(() => daemon.authenticated === 1);
    daemon.send({ type: "view.start", session: "default", maxFps: 5 });
    await until(() => frames("view.started").length === 1);
    expect(source.starts).toBe(1);
    source.emit("AAAA");
    await until(() => frames("frame").length === 1);
    expect(frames("frame")[0]).toMatchObject({ v: 1, session: "default", seq: 1, data: "AAAA" });
    daemon.send({ type: "view.stop", session: "default" });
    await until(() => frames("view.stopped").length === 1);
    expect(source.stops).toBe(1);
  });

  it("stops the stream when the connection drops, and does not resume after the redial", async () => {
    const source = new FakeSource();
    open().liveView!.register("default", source);
    await until(() => daemon.authenticated === 1);
    daemon.send({ type: "view.start", session: "default" });
    await until(() => source.starts === 1);
    daemon.drop();
    await until(() => source.stops === 1);
    await until(() => daemon.authenticated === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(source.starts).toBe(1);
    source.emit("AAAA");
    await new Promise((r) => setTimeout(r, 100));
    expect(frames("frame")).toEqual([]);
  });

  it("stops the stream when the channel closes", async () => {
    const source = new FakeSource();
    open().liveView!.register("default", source);
    await until(() => daemon.authenticated === 1);
    daemon.send({ type: "view.start", session: "default" });
    await until(() => source.starts === 1);
    channel!.close();
    await until(() => source.stops === 1);
  });

  it("stops the stream when its session unregisters, and tells the daemon why", async () => {
    const source = new FakeSource();
    const live = open().liveView!;
    live.register("default", source);
    await until(() => daemon.authenticated === 1);
    daemon.send({ type: "view.start", session: "default" });
    await until(() => source.starts === 1);
    await live.unregister("default");
    await until(() => frames("view.stopped").length === 1);
    expect(frames("view.stopped")[0]).toMatchObject({ reason: "session-closed" });
  });

  it("keeps request frames flowing while a stream runs", async () => {
    const source = new FakeSource();
    const ch = open();
    ch.liveView!.register("default", source);
    await until(() => daemon.authenticated === 1);
    daemon.send({ type: "view.start", session: "default" });
    await until(() => source.starts === 1);
    source.emit("A".repeat(40_960 * 3));
    const pending = ch.ask({
      session: "default",
      timeoutMs: 5_000,
      mask: (v) => v,
      prompt: { kind: "human", humanKind: "acknowledge", prompt: "ready?" },
    });
    const req = await daemon.nextRequest();
    daemon.answer(req.id, { decision: "done" });
    await expect(pending).resolves.toMatchObject({ decision: "done" });
    expect(frames("frame")).toHaveLength(3);
  });
});
