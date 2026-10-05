// A stand-in for the host daemon, for the operator-channel tests. It listens on a
// real Unix socket made the way the daemon is expected to make it (mode 0600 in
// a 0700 directory), speaks the handshake, records what browxai sends, and
// answers when a test tells it to. Test code only.

import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handshakeProof, proofMatches } from "../operator-protocol.js";

export type Frame = Record<string, unknown>;

export interface FakeDaemonOptions {
  /** The token browxai was given. Generated when omitted. */
  token?: string;
  /** Prove with a different token, as a process that took over the socket would. */
  proveWith?: string;
  /** Called on each hello, before the welcome goes out. Lets a test inject a
   *  frame ahead of authentication. */
  beforeWelcome?: (send: (frame: Frame) => void) => void;
  /** On a second and later connection, send the first connection's welcome
   *  instead of a fresh one: a replay of an old proof. */
  replayFirstWelcome?: boolean;
}

export interface FakeDaemon {
  dir: string;
  socketPath: string;
  token: string;
  /** Every frame browxai sent, in order, across connections. */
  frames: Frame[];
  /** Completed handshakes. */
  authenticated: number;
  /** Connections accepted, authenticated or not. */
  connections: number;
  /** The next `request` frame not yet returned. */
  nextRequest(): Promise<Frame>;
  send(frame: Frame): void;
  /** Write text to the connection as is, newline and all. */
  sendRaw(text: string): void;
  answer(id: unknown, body: Frame): void;
  drop(): void;
  close(): Promise<void>;
}

export async function startFakeDaemon(opts: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const token = opts.token ?? randomBytes(16).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "bx-op-"));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "d.sock");
  const frames: Frame[] = [];
  const waiters: Array<(f: Frame) => void> = [];
  let delivered = 0;
  const sockets = new Set<Socket>();
  let current: Socket | null = null;
  let firstWelcome: string | null = null;

  const daemon: FakeDaemon = {
    dir,
    socketPath,
    token,
    frames,
    authenticated: 0,
    connections: 0,
    nextRequest: () =>
      new Promise<Frame>((resolve) => {
        const pending = frames.filter((f) => f.type === "request");
        const next = pending[delivered];
        if (next) {
          delivered++;
          resolve(next);
        } else {
          waiters.push((f) => {
            delivered++;
            resolve(f);
          });
        }
      }),
    send: (frame) => void current?.write(JSON.stringify({ v: 1, ...frame }) + "\n"),
    sendRaw: (text) => void current?.write(text),
    answer: (id, body) => daemon.send({ type: "answer", id, ...body }),
    drop: () => current?.destroy(),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };

  const server: Server = createServer((sock) => {
    daemon.connections++;
    sockets.add(sock);
    current = sock;
    sock.setEncoding("utf8");
    let buf = "";
    let helloNonce = "";
    const daemonNonce = randomBytes(16).toString("hex");
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => undefined);
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        const f = JSON.parse(line) as Frame;
        frames.push(f);
        if (f.type === "hello") {
          helloNonce = String(f.nonce);
          opts.beforeWelcome?.(
            (frame) => void sock.write(JSON.stringify({ v: 1, ...frame }) + "\n"),
          );
          const fresh = JSON.stringify({
            v: 1,
            type: "welcome",
            nonce: daemonNonce,
            proof: handshakeProof(opts.proveWith ?? token, "daemon", helloNonce, daemonNonce),
          });
          firstWelcome ??= fresh;
          sock.write((opts.replayFirstWelcome ? firstWelcome : fresh) + "\n");
        } else if (f.type === "auth") {
          const expected = handshakeProof(token, "browxai", helloNonce, daemonNonce);
          if (proofMatches(expected, f.proof)) {
            daemon.authenticated++;
            sock.write(JSON.stringify({ v: 1, type: "ready" }) + "\n");
          } else {
            sock.destroy();
          }
        } else if (f.type === "request") {
          const w = waiters.shift();
          if (w) w(f);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return daemon;
}
