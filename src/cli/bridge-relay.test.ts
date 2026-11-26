import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  BridgeRelay,
  RelayFatalError,
  type DaemonLink,
  type RelayOptions,
} from "./bridge-relay.js";

type Msg = Record<string, unknown>;
const asMessage = (m: Msg): JSONRPCMessage => m as unknown as JSONRPCMessage;

const request = (id: number | string, method = "tools/call", params: Msg = {}): Msg => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const result = (id: number | string, value: Msg = {}): Msg => ({
  jsonrpc: "2.0",
  id,
  result: value,
});
const notification = (method: string, params: Msg = {}): Msg => ({
  jsonrpc: "2.0",
  method,
  params,
});

const INIT = request("init-1", "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test-client", version: "1" },
});
const INITIALIZED = notification("notifications/initialized");
const initResult = (over: Msg = {}): Msg =>
  result("init-1", {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "browxai", version: "1.0.0" },
    ...over,
  });

/** Let queued sends and their callbacks run. */
const settle = async (): Promise<void> => {
  // cap: a fixed number of turns of the event loop.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Wait until `cond` holds, or fail after two seconds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  // cap: ends at `deadline`.
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** One daemon connection as the test sees it: what arrived, and how to answer or drop. */
interface FakeDaemon {
  readonly received: Msg[];
  readonly flow: string[];
  send(m: Msg): Promise<void>;
  drop(): Promise<void>;
  /** Report an error on the relay's side of the connection, as its transport would. */
  fail(err: Error): void;
}

function rig(over: Partial<RelayOptions> = {}) {
  const [testClient, relayClient] = InMemoryTransport.createLinkedPair();
  const toClient: Msg[] = [];
  testClient.onmessage = (m) => toClient.push(m);
  const daemons: FakeDaemon[] = [];
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const sleeps: Array<{ ms: number; wake: () => void }> = [];
  const clientFlow: string[] = [];
  let openFails: Error | undefined;

  const newLink = (): DaemonLink => {
    const [relaySide, daemonSide] = InMemoryTransport.createLinkedPair();
    const received: Msg[] = [];
    const flow: string[] = [];
    daemonSide.onmessage = (m) => received.push(m);
    daemons.push({
      received,
      flow,
      send: (m) => daemonSide.send(asMessage(m)),
      drop: () => daemonSide.close(),
      fail: (err) => relaySide.onerror?.(err),
    });
    return {
      transport: relaySide,
      pause: () => flow.push("pause"),
      resume: () => flow.push("resume"),
    };
  };

  const relay = new BridgeRelay({
    client: relayClient,
    clientFlow: {
      pause: () => clientFlow.push("pause"),
      resume: () => clientFlow.push("resume"),
    },
    openDaemon: () => (openFails ? Promise.reject(openFails) : Promise.resolve(newLink())),
    log: (message, fields) => logs.push({ message, fields }),
    sleep: (ms) => new Promise<void>((wake) => sleeps.push({ ms, wake })),
    ...over,
  });

  return {
    relay,
    toClient,
    daemons,
    logs,
    sleeps,
    clientFlow,
    newLink,
    failOpens: (err: Error | undefined) => (openFails = err),
    fromClient: async (m: Msg) => {
      await testClient.send(asMessage(m));
      await settle();
    },
    /** Finish the wait the reconnect loop is in, and let the attempt run. */
    wake: async () => {
      await until(() => sleeps.length > 0, "a reconnect wait");
      sleeps.shift()!.wake();
      await settle();
    },
    start: async () => {
      await testClient.start();
      await relay.start(newLink());
      await settle();
    },
  };
}

/** A started relay whose client has finished the handshake with the first daemon. */
async function initialized(over: Partial<RelayOptions> = {}) {
  const r = rig(over);
  await r.start();
  await r.fromClient(INIT);
  await r.daemons[0]!.send(initResult());
  await settle();
  await r.fromClient(INITIALIZED);
  r.toClient.length = 0;
  return r;
}

describe("bridge relay: passing messages", () => {
  it("passes a request and its response with the id and the body unchanged", async () => {
    const r = rig();
    await r.start();
    const call = request(7, "tools/call", { name: "click", arguments: { ref: "e1" } });
    await r.fromClient(call);
    expect(r.daemons[0]!.received).toEqual([call]);
    expect(r.relay.openRequests).toBe(1);

    const answer = result(7, { content: [{ type: "text", text: "{}" }] });
    await r.daemons[0]!.send(answer);
    await settle();
    expect(r.toClient).toEqual([answer]);
    expect(r.relay.openRequests).toBe(0);
  });

  it("keeps a string id a string and a number id a number", async () => {
    const r = rig();
    await r.start();
    await r.fromClient(request("7"));
    await r.fromClient(request(7));
    expect(r.daemons[0]!.received.map((m) => m.id)).toEqual(["7", 7]);
    expect(r.relay.openRequests).toBe(2);
    await r.daemons[0]!.send(result("7"));
    await settle();
    expect(r.relay.openRequests).toBe(1);
  });

  it("passes the initialize request and its result unchanged", async () => {
    const r = rig();
    await r.start();
    await r.fromClient(INIT);
    await r.daemons[0]!.send(initResult());
    await settle();
    expect(r.daemons[0]!.received).toEqual([INIT]);
    expect(r.toClient).toEqual([initResult()]);
    expect(r.logs.some((l) => l.fields?.daemonVersion === "1.0.0")).toBe(true);
  });

  it("passes notifications in both directions", async () => {
    const r = rig();
    await r.start();
    const progress = notification("notifications/progress", { progressToken: 1, progress: 5 });
    const listChanged = notification("notifications/tools/list_changed");
    await r.fromClient(progress);
    await r.daemons[0]!.send(listChanged);
    await settle();
    expect(r.daemons[0]!.received).toEqual([progress]);
    expect(r.toClient).toEqual([listChanged]);
    expect(r.relay.openRequests).toBe(0);
  });

  it("passes a request from the daemon and the client's response to it", async () => {
    const r = rig();
    await r.start();
    const ask = request("srv-1", "roots/list");
    await r.daemons[0]!.send(ask);
    await settle();
    await r.fromClient(result("srv-1", { roots: [] }));
    expect(r.toClient).toEqual([ask]);
    expect(r.daemons[0]!.received).toEqual([result("srv-1", { roots: [] })]);
  });

  it("keeps the order of messages in each direction", async () => {
    const r = rig();
    await r.start();
    const ids = Array.from({ length: 25 }, (_, i) => i);
    for (const id of ids) await r.fromClient(request(id));
    for (const id of [...ids].reverse()) await r.daemons[0]!.send(result(id));
    await settle();
    expect(r.daemons[0]!.received.map((m) => m.id)).toEqual(ids);
    expect(r.toClient.map((m) => m.id)).toEqual([...ids].reverse());
  });

  it("forgets a request the client cancelled, and passes the cancel on", async () => {
    const r = rig();
    await r.start();
    await r.fromClient(request(1));
    await r.fromClient(request(2));
    const cancel = notification("notifications/cancelled", { requestId: 1 });
    await r.fromClient(cancel);
    expect(r.relay.openRequests).toBe(1);
    expect(r.daemons[0]!.received[2]).toEqual(cancel);
  });
});

/** A transport whose writes wait until the test lets them through. */
class GatedTransport implements Transport {
  public readonly sent: Msg[] = [];
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;
  private _open: () => void = () => undefined;
  private _gate = new Promise<void>((resolve) => (this._open = resolve));

  public start(): Promise<void> {
    return Promise.resolve();
  }
  public async send(message: JSONRPCMessage): Promise<void> {
    await this._gate;
    this.sent.push(message);
  }
  public close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
  public release(): void {
    this._open();
  }
}

describe("bridge relay: a slow writer", () => {
  it("pauses the client while the daemon is behind, and resumes it when the queue is empty", async () => {
    // One waiting message is under the limit and two are over it. The message being
    // written is not counted.
    const r = rig({ highWaterBytes: 300 });
    const slow = new GatedTransport();
    await r.relay.start({ transport: slow });
    const big = (id: number) => request(id, "tools/call", { pad: "x".repeat(150) });

    await r.fromClient(big(1));
    expect(r.clientFlow).toEqual([]);
    await r.fromClient(big(2));
    expect(r.clientFlow).toEqual([]);
    await r.fromClient(big(3));
    expect(r.clientFlow).toEqual(["pause"]);
    expect(slow.sent).toEqual([]);

    slow.release();
    await settle();
    expect(slow.sent.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(r.clientFlow).toEqual(["pause", "resume"]);
  });

  it("pauses the daemon connection while the client is behind", async () => {
    const slowClient = new GatedTransport();
    const r = rig({ client: slowClient, highWaterBytes: 300 });
    await r.relay.start(r.newLink());
    const big = (id: number) => result(id, { pad: "x".repeat(150) });
    for (const id of [1, 2, 3]) await r.daemons[0]!.send(big(id));
    await settle();
    expect(r.daemons[0]!.flow).toEqual(["pause"]);

    slowClient.release();
    await settle();
    expect(slowClient.sent.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(r.daemons[0]!.flow).toEqual(["pause", "resume"]);
  });
});

describe("bridge relay: a lost daemon connection", () => {
  it("answers every open request once with a connection-closed error, and no cancelled one", async () => {
    const r = await initialized();
    await r.fromClient(request(1));
    await r.fromClient(request("two"));
    await r.fromClient(request(3));
    await r.fromClient(notification("notifications/cancelled", { requestId: 3 }));
    await r.daemons[0]!.drop();
    await settle();

    expect(r.toClient.map((m) => m.id)).toEqual([1, "two"]);
    for (const m of r.toClient) {
      const error = m.error as { code: number; message: string };
      expect(error.code).toBe(-32000);
      expect(error.message).toContain("connection to the daemon was lost");
      expect(error.message).toContain("may or may not have run");
    }
    expect(r.relay.openRequests).toBe(0);
  });

  it("names the reason the transport gave, such as the line limit", async () => {
    const r = await initialized();
    await r.fromClient(request(1));
    r.daemons[0]!.fail(
      new Error(
        "SocketTransport: an incoming message is over the 33554432-byte limit; closing the connection",
      ),
    );
    await r.daemons[0]!.drop();
    await settle();
    const error = r.toClient[0]!.error as { message: string };
    expect(error.message).toContain("33554432-byte limit");
  });

  it("answers a request that arrives during the gap at once, and sends it nowhere", async () => {
    const r = await initialized();
    await r.daemons[0]!.drop();
    await settle();
    await r.fromClient(request(9));
    await r.fromClient(notification("notifications/progress", { progressToken: 1, progress: 1 }));
    expect(r.toClient).toHaveLength(1);
    const error = r.toClient[0]!.error as { code: number; message: string };
    expect(r.toClient[0]!.id).toBe(9);
    expect(error.code).toBe(-32000);
    expect(error.message).toContain("was not sent");
    expect(r.daemons).toHaveLength(1);
    expect(r.relay.openRequests).toBe(0);
  });

  it("repeats the saved handshake on the new connection and keeps the answer to itself", async () => {
    const r = await initialized();
    await r.daemons[0]!.drop();
    await r.wake();
    expect(r.daemons).toHaveLength(2);
    const second = r.daemons[1]!;
    expect(second.received).toEqual([INIT]);

    // A request that arrives before the new daemon answered waits for the handshake.
    await r.fromClient(request(11));
    expect(second.received).toEqual([INIT]);

    await second.send(initResult());
    await settle();
    expect(second.received).toEqual([INIT, INITIALIZED, request(11)]);
    expect(r.toClient).toEqual([]);

    await second.send(result(11));
    await settle();
    expect(r.toClient).toEqual([result(11)]);
  });

  it("carries on, and logs it, when only the daemon's version changed", async () => {
    const r = await initialized();
    await r.daemons[0]!.drop();
    await r.wake();
    await r.daemons[1]!.send(initResult({ serverInfo: { name: "browxai", version: "2.0.0" } }));
    await settle();
    await r.fromClient(request(4));
    expect(r.daemons[1]!.received.at(-1)).toEqual(request(4));
    const changed = r.logs.find((l) => l.message.includes("version changed"));
    expect(changed?.fields).toEqual({ before: "1.0.0", now: "2.0.0" });
  });

  it.each([
    ["capabilities", { capabilities: { tools: { listChanged: true } } }],
    ["protocol version", { protocolVersion: "2024-11-05" }],
  ])("ends with exit 3 when the new daemon negotiated a different %s", async (_what, over) => {
    const r = await initialized();
    await r.daemons[0]!.drop();
    await r.wake();
    await r.fromClient(request(5));
    await r.daemons[1]!.send(initResult(over));
    const end = await r.relay.done;
    expect(end.code).toBe(3);
    expect(end.message).toContain("different protocol version or different capabilities");
    // The request that was waiting for the handshake is answered, not left open.
    expect(r.toClient.map((m) => m.id)).toEqual([5]);
    expect(r.daemons[1]!.received).toEqual([INIT]);
  });

  it("treats capabilities with the same content in another key order as the same", async () => {
    const r = rig();
    await r.start();
    await r.fromClient(INIT);
    await r.daemons[0]!.send(initResult({ capabilities: { tools: {}, logging: {} } }));
    await settle();
    await r.daemons[0]!.drop();
    await r.wake();
    await r.daemons[1]!.send(initResult({ capabilities: { logging: {}, tools: {} } }));
    await settle();
    await r.fromClient(request(6));
    expect(r.daemons[1]!.received.at(-1)).toEqual(request(6));
  });

  it("repeats nothing when the client never got an initialize result", async () => {
    const r = rig();
    await r.start();
    await r.fromClient(INIT);
    await r.daemons[0]!.drop();
    await settle();
    expect(r.toClient.map((m) => m.id)).toEqual(["init-1"]);
    await r.wake();
    expect(r.daemons[1]!.received).toEqual([]);
    // The client's own second initialize goes through as a normal request.
    await r.fromClient(INIT);
    expect(r.daemons[1]!.received).toEqual([INIT]);
  });

  it("waits longer after each failed attempt, up to the longest wait", async () => {
    const r = await initialized({ retryFirstMs: 250, retryMaxMs: 1_000 });
    r.failOpens(new Error("ECONNREFUSED"));
    await r.daemons[0]!.drop();
    const waits: number[] = [];
    // cap: five attempts.
    for (let i = 0; i < 5; i++) {
      await until(() => r.sleeps.length > 0, "a reconnect wait");
      waits.push(r.sleeps[0]!.ms);
      await r.wake();
    }
    expect(waits).toEqual([250, 500, 1_000, 1_000, 1_000]);
    expect(r.daemons).toHaveLength(1);

    r.failOpens(undefined);
    await r.wake();
    expect(r.daemons).toHaveLength(2);
  });

  it("ends with exit 3 when opening the daemon fails for good", async () => {
    const r = await initialized();
    r.failOpens(new RelayFatalError("browxai bridge: refusing to connect: not yours"));
    await r.daemons[0]!.drop();
    await r.wake();
    const end = await r.relay.done;
    expect(end).toEqual({ code: 3, message: "browxai bridge: refusing to connect: not yours" });
  });

  it("closes a new connection that does not answer the handshake, and tries again", async () => {
    const r = await initialized({ handshakeTimeoutMs: 20 });
    await r.daemons[0]!.drop();
    await r.wake();
    expect(r.daemons[1]!.received).toEqual([INIT]);
    await r.wake();
    expect(r.daemons).toHaveLength(3);
    expect(r.daemons[2]!.received).toEqual([INIT]);
  });

  it("drops a daemon line that is not a message and logs its kind only", async () => {
    const r = await initialized();
    const err = new SyntaxError('Unexpected token, "secret-value" is not valid JSON');
    r.daemons[0]!.fail(err);
    await r.fromClient(request(1));
    expect(r.daemons[0]!.received.at(-1)).toEqual(request(1));
    expect(JSON.stringify(r.logs)).not.toContain("secret-value");
    expect(r.logs.at(-1)?.fields).toEqual({ kind: "SyntaxError" });
  });
});

describe("bridge relay: the end", () => {
  it("waits for the responses on their way when the client closes its input, then exits 0", async () => {
    const r = await initialized();
    await r.fromClient(request(1));
    const drained = r.relay.drain(60_000);
    await settle();
    await r.daemons[0]!.send(result(1));
    await drained;
    expect(await r.relay.done).toEqual({ code: 0 });
    expect(r.toClient).toEqual([result(1)]);
  });

  it("stops waiting for responses when the grace time is over", async () => {
    const r = await initialized();
    await r.fromClient(request(1));
    const drained = r.relay.drain(2_000);
    await until(() => r.sleeps.length > 0, "the grace wait");
    expect(r.sleeps[0]!.ms).toBe(2_000);
    r.sleeps.shift()!.wake();
    await drained;
    expect(await r.relay.done).toEqual({ code: 0 });
  });

  it("exits 0 at once when it is closed, and reconnects no more", async () => {
    const r = await initialized();
    await r.fromClient(request(1));
    await r.relay.close();
    expect(await r.relay.done).toEqual({ code: 0 });
    await settle();
    expect(r.daemons).toHaveLength(1);
    expect(r.sleeps).toHaveLength(0);
  });
});

describe("bridge relay: the SDK's stdio transport as the client side", () => {
  function overStdio(maxBufferSize: number) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
    const r = rig({
      client: new StdioServerTransport(stdin, stdout, { maxBufferSize }),
      clientLineLimit: "the test limit",
    });
    return { ...r, stdin, lines: () => out.join("").split("\n").filter(Boolean) };
  }

  it("relays lines in and lines out", async () => {
    const r = overStdio(4_096);
    await r.relay.start(r.newLink());
    r.stdin.write(`${JSON.stringify(request(1))}\n`);
    await settle();
    expect(r.daemons[0]!.received).toEqual([request(1)]);
    await r.daemons[0]!.send(result(1));
    await settle();
    expect(r.lines().map((l) => JSON.parse(l) as Msg)).toEqual([result(1)]);
  });

  it("drops a line that is not a message, logs its kind only, and reads the next line", async () => {
    const r = overStdio(4_096);
    await r.relay.start(r.newLink());
    r.stdin.write('{"password":"hunter2"\n');
    r.stdin.write(`${JSON.stringify(request(2))}\n`);
    await settle();
    expect(r.daemons[0]!.received).toEqual([request(2)]);
    expect(r.lines()).toEqual([]);
    expect(JSON.stringify(r.logs)).not.toContain("hunter2");
    expect(r.logs.some((l) => l.message.includes("dropped a line from the client"))).toBe(true);
  });

  it("ends with exit 1 and names the limit when the client sends a line over it", async () => {
    const r = overStdio(256);
    await r.relay.start(r.newLink());
    r.stdin.write("x".repeat(300));
    const end = await r.relay.done;
    expect(end.code).toBe(1);
    expect(end.message).toContain("a line over the test limit");
  });
});
