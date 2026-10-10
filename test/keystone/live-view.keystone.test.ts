// Live-view keystone. With the off-by-default `live-view` capability on (and
// `operator-channel` with it), the daemon on the operator socket can start a
// CDP screencast of a session and the frames go back on that socket, paced and
// bounded, and nowhere else.
//
// Real Chromium, a real Unix socket and a stand-in daemon. A mocked page or
// socket would pass whether or not Chromium delivers frames, the 64 KiB line
// limit holds for real JPEG sizes, or the agent can reach the stream.
//
//   1. live-view without operator-channel: the server refuses to start.
//   2. Capability unset (operator-channel on): a view.start gets `view-disabled`,
//      no frame is ever sent, and `set_config` cannot turn the capability on.
//   3. Capability set: frames arrive at the 5 fps cap as real JPEGs under the
//      line limit; nothing the agent can call names or carries the stream; no
//      frame lands in the workspace or the log; view.stop, a closed session and
//      a dropped connection each end the stream; a daemon that acks slowly is
//      stepped down to 640 px, and one that does not ack gets one frame.
//
// The page is animated by CSS only. Nothing on it calls back into CDP, so the
// only CDP traffic is the screencast under test.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFakeDaemon, type FakeDaemon } from "../../src/helper/__fixtures__/operator-daemon.js";
import { waitFor } from "./fixture.js";

const KEYSTONE_TIMEOUT = 120_000;
const CAPS_ON = "read,navigation,action,human,operator-channel,live-view";
const CAPS_CHANNEL_ONLY = "read,navigation,action,human,operator-channel";
const CAPS_VIEW_ONLY = "read,navigation,action,human,live-view";
const MAX_LINE_BYTES = 64 * 1024;

// Everything browxai writes to stderr, so a test can assert what never appears.
const stderrLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

// A compositor animation with no script: Chromium paints it continuously, so
// the screencast always has a new frame to offer.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>live</title>
<style>
  html, body { margin: 0; height: 100%; background: #123; }
  .bar { position: absolute; top: 0; left: 0; width: 40%; height: 100%;
         background: linear-gradient(90deg, #e33, #3e3, #33e);
         animation: slide 1.2s linear infinite alternate; }
  @keyframes slide { from { transform: translateX(0); } to { transform: translateX(150%); } }
  h1 { position: absolute; color: #fff; font: 48px sans-serif; margin: 24px; }
</style></head>
<body><div class="bar"></div><h1>operator view keystone</h1></body></html>`;

// A page the screencast cannot compress well: random 3 px cells, drawn once. Its
// JPEG is well over 64 KiB, so a frame has to travel as parts.
const NOISE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>noise</title>
<style>html,body{margin:0;background:#000}canvas{display:block}</style></head>
<body><canvas id="c" width="1280" height="720"></canvas><script>
var c = document.getElementById("c").getContext("2d");
for (var y = 0; y < 720; y += 3) for (var x = 0; x < 1280; x += 3) {
  c.fillStyle = "rgb(" + (Math.random() * 256 | 0) + "," + (Math.random() * 256 | 0) + "," + (Math.random() * 256 | 0) + ")";
  c.fillRect(x, y, 3, 3);
}
</script></body></html>`;

let http: Server;
let base: string;

// The BROWX_ variables found when this file loaded, and only those. Each suite
// sets its own, and recording what a later `isolateEnv` finds would hand this
// file's settings to the next file in the shared keystone process as if they
// were the original ones.
const originalEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith("BROWX_")),
);

function isolateEnv(prefix: string): string {
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  const ws = mkdtempSync(join(tmpdir(), prefix));
  process.env.BROWX_WORKSPACE = ws;
  return ws;
}

type Server_ = Awaited<ReturnType<typeof createServer>>;
function caller(server: Server_) {
  return async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const fn = server.handlers[name];
    if (!fn) throw new Error(`live-view keystone: no handler "${name}"`);
    const res = await fn(args);
    return JSON.parse((res.content[0] as { text: string }).text) as T;
  };
}

function operatorEnv(d: FakeDaemon): NodeJS.ProcessEnv {
  return { BROWX_OPERATOR_SOCKET: d.socketPath, BROWX_OPERATOR_TOKEN: d.token };
}

// Fixed windows below prove an event does NOT happen; waiting for something
// that should happen goes through waitFor.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = Record<string, unknown>;
const ofType = (d: FakeDaemon, type: string): Frame[] => d.frames.filter((f) => f.type === type);

/** Frames whose last part has arrived, in order. */
const completeFrames = (d: FakeDaemon, session?: string): Frame[] =>
  ofType(d, "frame").filter(
    (f) => f.part === (f.parts as number) - 1 && (!session || f.session === session),
  );

/** The JPEG a frame's parts add up to. */
function jpegOf(d: FakeDaemon, session: string, seq: number): Buffer {
  const parts = ofType(d, "frame")
    .filter((f) => f.session === session && f.seq === seq)
    .sort((a, b) => (a.part as number) - (b.part as number));
  return Buffer.concat(parts.map((p) => Buffer.from(p.data as string, "base64")));
}

/** Acks each complete frame `delayMs` after it arrives, the way a daemon that
 *  has handed it on would. Records when each ack went out. */
function autoAck(d: FakeDaemon, delayMs = 0) {
  const ackedAt = new Map<number, number>();
  let cursor = 0;
  const timers = new Set<NodeJS.Timeout>();
  const poll = setInterval(() => {
    for (; cursor < d.frames.length; cursor++) {
      const f = d.frames[cursor]!;
      if (f.type !== "frame" || f.part !== (f.parts as number) - 1) continue;
      const t = setTimeout(() => {
        timers.delete(t);
        ackedAt.set(f.seq as number, Date.now());
        d.send({ type: "frame.ack", session: f.session, seq: f.seq });
      }, delayMs);
      timers.add(t);
    }
  }, 25);
  return {
    ackedAt,
    stop: () => {
      clearInterval(poll);
      for (const t of timers) clearTimeout(t);
    },
  };
}

/** Every regular file under `dir` of at most 64 MiB, as a Buffer. */
function* filesUnder(dir: string): Generator<Buffer> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* filesUnder(p);
    else if (st.isFile() && st.size < 64 * 1024 * 1024) {
      try {
        yield readFileSync(p);
      } catch {
        /* unreadable: skip */
      }
    }
  }
}

beforeAll(async () => {
  process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    stderrLog.push(String(chunk));
    return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  http = createHttp((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url?.startsWith("/noise") ? NOISE_PAGE : PAGE);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  process.stderr.write = realStderrWrite;
  await new Promise<void>((r) => http.close(() => r()));
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  Object.assign(process.env, originalEnv);
}, KEYSTONE_TIMEOUT);

// ---------------------------------------------------------------------------
// 1. live-view needs operator-channel.
// ---------------------------------------------------------------------------

describe("live view — without operator-channel", () => {
  it("refuses to start the server, and the socket variables are still taken out", async () => {
    const ws = isolateEnv("browx-view-nochannel-");
    const daemon = await startFakeDaemon();
    try {
      process.env.BROWX_CAPABILITIES = CAPS_VIEW_ONLY;
      Object.assign(process.env, operatorEnv(daemon));
      await expect(createServer({ headless: true })).rejects.toThrow(
        /live-view.*needs operator-channel/,
      );
      expect(process.env.BROWX_OPERATOR_SOCKET).toBeUndefined();
      expect(process.env.BROWX_OPERATOR_TOKEN).toBeUndefined();
      await sleep(300); // absence window: no dial may happen
      expect(daemon.connections).toBe(0);
    } finally {
      await daemon.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Capability unset.
// ---------------------------------------------------------------------------

describe("live view — capability unset", () => {
  let daemon: FakeDaemon;
  let server: Server_;
  let workspace: string;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    workspace = isolateEnv("browx-view-off-");
    daemon = await startFakeDaemon();
    process.env.BROWX_CAPABILITIES = CAPS_CHANNEL_ONLY;
    Object.assign(process.env, operatorEnv(daemon));
    server = await createServer({ headless: true });
    call = caller(server);
    await waitFor(() => daemon.authenticated === 1);
    await call("open_session", { session: "off", mode: "incognito" });
    await call("navigate", { session: "off", url: base });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    await daemon?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it("answers view.start with view-disabled and never sends a frame", async () => {
    daemon.send({ type: "view.start", session: "off" });
    await waitFor(() => ofType(daemon, "error").length === 1);
    expect(ofType(daemon, "error")[0]).toMatchObject({ code: "view-disabled", session: "off" });
    await sleep(1_500); // absence window: no frame may be sent
    expect(ofType(daemon, "frame")).toEqual([]);
    expect(ofType(daemon, "view.started")).toEqual([]);
  });

  it("set_config cannot turn the capability on", async () => {
    const refused = await call<{ ok: boolean; error: string; widening: string[] }>("set_config", {
      scope: "user",
      patch: { capabilities: [...CAPS_ON.split(",")] },
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe("capabilities-not-widenable");
    expect(refused.widening).toEqual(["live-view"]);
    const resolved = await call<{ config: { capabilities: string[] } }>("get_config", {});
    expect(resolved.config.capabilities).not.toContain("live-view");
  });
});

// ---------------------------------------------------------------------------
// 3. Capability set.
// ---------------------------------------------------------------------------

describe("live view — capability set, managed Chromium", () => {
  let daemon: FakeDaemon;
  let server: Server_;
  let workspace: string;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    workspace = isolateEnv("browx-view-on-");
    daemon = await startFakeDaemon();
    process.env.BROWX_CAPABILITIES = CAPS_ON;
    Object.assign(process.env, operatorEnv(daemon));
    server = await createServer({ headless: true });
    call = caller(server);
    await waitFor(() => daemon.authenticated === 1);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    await daemon?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  async function openOn(session: string): Promise<void> {
    await call("open_session", { session, mode: "incognito" });
    await call("navigate", { session, url: base });
  }

  const stopped = (session: string) =>
    ofType(daemon, "view.stopped").filter((f) => f.session === session);

  it("warns at start that masking does not cover pixels", () => {
    const out = stderrLog.join("");
    expect(out).toContain("live-view capability is ENABLED");
    expect(out).toContain("SECRET MASKING DOES NOT COVER PIXELS");
  });

  it("streams JPEG frames at the 5 fps cap, each line under the 64 KiB limit", async () => {
    await openOn("a");
    const ack = autoAck(daemon);
    try {
      daemon.send({ type: "view.start", session: "a" });
      await waitFor(() => ofType(daemon, "view.started").length === 1);
      expect(ofType(daemon, "view.started")[0]).toMatchObject({
        session: "a",
        format: "jpeg",
        maxFps: 5,
        maxWidth: 960,
        quality: 60,
      });
      await waitFor(() => completeFrames(daemon, "a").length >= 1);
      // Ten paced frames at 5 fps, however long a loaded box takes to deliver them.
      await waitFor(() => completeFrames(daemon, "a").length >= 10, { timeoutMs: 30_000 });
      // The send times browxai stamped on the frames. A mean gap under 200 ms
      // would mean frames are not paced to the cap. A mean gap near half a
      // second would mean the stream is not keeping up with a page that paints
      // continuously.
      const at = completeFrames(daemon, "a").map((f) => f.at as number);
      expect(at.length).toBeGreaterThanOrEqual(10);
      const gap = (at[at.length - 1]! - at[0]!) / (at.length - 1);
      expect(gap).toBeGreaterThanOrEqual(190);
      expect(gap).toBeLessThanOrEqual(400);
    } finally {
      ack.stop();
    }

    for (const f of ofType(daemon, "frame")) {
      expect(Buffer.byteLength(JSON.stringify(f))).toBeLessThan(MAX_LINE_BYTES);
    }
    const first = completeFrames(daemon, "a")[0]!;
    const jpeg = jpegOf(daemon, "a", first.seq as number);
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(jpeg.subarray(-2).toString("hex")).toBe("ffd9");
    expect(first.width as number).toBeLessThanOrEqual(960);
    expect(first.width as number).toBeGreaterThan(0);
    expect(first.height as number).toBeGreaterThan(0);
    const seqs = completeFrames(daemon, "a").map((f) => f.seq as number);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("sends a frame over 64 KiB as parts that join into one JPEG, each line under the limit", async () => {
    await call("open_session", { session: "big", mode: "incognito" });
    await call("navigate", { session: "big", url: `${base}/noise` });
    const ack = autoAck(daemon);
    try {
      daemon.send({ type: "view.start", session: "big", quality: 80 });
      await waitFor(() => completeFrames(daemon, "big").length >= 1);
    } finally {
      ack.stop();
    }
    const first = completeFrames(daemon, "big")[0]!;
    expect(first.parts as number).toBeGreaterThan(1);
    expect(first.parts as number).toBeLessThanOrEqual(16);
    const lines = ofType(daemon, "frame").filter((f) => f.session === "big" && f.seq === first.seq);
    expect(lines).toHaveLength(first.parts as number);
    for (const line of lines) {
      expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThan(MAX_LINE_BYTES);
    }
    const jpeg = jpegOf(daemon, "big", first.seq as number);
    expect(jpeg.length).toBeGreaterThan(64 * 1024);
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(jpeg.subarray(-2).toString("hex")).toBe("ffd9");
    daemon.send({ type: "view.stop", session: "big" });
    await waitFor(() => stopped("big").length === 1);
    await call("close_session", { session: "big" });
  });

  it("sends nothing after view.stop, and the session keeps working", async () => {
    daemon.send({ type: "view.stop", session: "a" });
    await waitFor(() => stopped("a").length === 1);
    expect(stopped("a")[0]).toMatchObject({ reason: "daemon" });
    await sleep(400); // lets a frame already in flight land before counting
    const n = ofType(daemon, "frame").length;
    await sleep(1_000); // absence window: no frame after stop
    expect(ofType(daemon, "frame").length).toBe(n);
    const again = await call<{ ok: boolean }>("navigate", { session: "a", url: base });
    expect(again.ok).toBe(true);
  });

  it("gives the agent no tool for the stream and no trace of it in what its tools return", async () => {
    await openOn("b");
    const ack = autoAck(daemon);
    try {
      daemon.send({ type: "view.start", session: "b" });
      await waitFor(() => completeFrames(daemon, "b").length >= 2);
      expect(Object.keys(server.handlers).filter((n) => /live|screencast|stream/i.test(n))).toEqual(
        [],
      );
      const outputs = JSON.stringify([
        await call("get_config", {}),
        await call("get_config", { scope: "env" }),
        await call("list_sessions", {}),
        await call("list_approvals", {}),
      ]);
      const sample = (completeFrames(daemon, "b")[0]!.data as string).slice(0, 80);
      expect(outputs).not.toContain("/9j/");
      expect(outputs).not.toContain(sample);
      expect(outputs).not.toMatch(/screencast|frame\.ack|view\.start/i);
      expect(outputs).not.toContain(daemon.socketPath);
      expect(outputs).not.toContain(daemon.token);
    } finally {
      ack.stop();
    }
  });

  it("writes no frame to the workspace or the log", async () => {
    const f = completeFrames(daemon, "b")[0]!;
    const jpeg = jpegOf(daemon, "b", f.seq as number);
    expect(jpeg.length).toBeGreaterThan(1_000);
    const probe = jpeg.subarray(Math.floor(jpeg.length / 2), Math.floor(jpeg.length / 2) + 256);
    let hits = 0;
    for (const file of filesUnder(workspace)) if (file.includes(probe)) hits++;
    expect(hits).toBe(0);
    const log = stderrLog.join("");
    expect(log).not.toContain((f.data as string).slice(0, 80));
    expect(log).not.toContain("/9j/");
    expect(log).not.toContain(daemon.token);
  });

  it("stops the stream when its session closes, and tells the daemon", async () => {
    await call("close_session", { session: "b" });
    await waitFor(() => stopped("b").length === 1);
    expect(stopped("b")[0]).toMatchObject({ reason: "session-closed" });
    daemon.send({ type: "view.start", session: "b" });
    await waitFor(() => ofType(daemon, "error").some((e) => e.session === "b"));
    expect(ofType(daemon, "error").find((e) => e.session === "b")).toMatchObject({
      code: "unknown-session",
    });
  });

  it("refuses a view.start for a session that was never opened, and opens none", async () => {
    daemon.send({ type: "view.start", session: "never-opened" });
    await waitFor(() => ofType(daemon, "error").some((e) => e.session === "never-opened"));
    const listed = await call<{ sessions: Array<{ id: string }> }>("list_sessions", {});
    expect(listed.sessions.map((s) => s.id)).not.toContain("never-opened");
  });

  it("sends one frame and holds the rest while the daemon does not ack", async () => {
    await openOn("c");
    daemon.send({ type: "view.start", session: "c" });
    await waitFor(() => completeFrames(daemon, "c").length === 1);
    await sleep(3_000); // absence window, inside the 5 s ack timeout: no second frame
    expect(completeFrames(daemon, "c")).toHaveLength(1);
    daemon.send({ type: "view.stop", session: "c" });
    await waitFor(() => stopped("c").length === 1);
  });

  it(
    "steps down to 640 px when the daemon acks slowly, and never sends ahead of an ack",
    async () => {
      await openOn("d");
      const ack = autoAck(daemon, 900);
      try {
        daemon.send({ type: "view.start", session: "d", maxFps: 5, maxWidth: 960 });
        await waitFor(() => completeFrames(daemon, "d").length >= 1);
        await waitFor(
          () => {
            const last = completeFrames(daemon, "d").at(-1);
            return !!last && (last.width as number) <= 640;
          },
          { timeoutMs: 25_000 },
        );
        const frames = completeFrames(daemon, "d");
        expect(frames[0]!.width as number).toBeGreaterThan(640);
        // One in flight at a time: each frame went out after the one before it was acked.
        for (let i = 1; i < frames.length; i++) {
          const prevAck = ack.ackedAt.get(frames[i - 1]!.seq as number);
          expect(prevAck).toBeDefined();
          expect(frames[i]!.at as number).toBeGreaterThanOrEqual(prevAck!);
        }
      } finally {
        ack.stop();
      }
      daemon.send({ type: "view.stop", session: "d" });
      await waitFor(() => stopped("d").length === 1);
    },
    KEYSTONE_TIMEOUT,
  );

  it("stops the stream when the connection drops, and does not resume after the redial", async () => {
    await openOn("e");
    const ack = autoAck(daemon);
    try {
      daemon.send({ type: "view.start", session: "e" });
      await waitFor(() => completeFrames(daemon, "e").length >= 1);
    } finally {
      ack.stop();
    }
    const authed = daemon.authenticated;
    daemon.drop();
    await waitFor(() => daemon.authenticated === authed + 1);
    await sleep(500); // lets a frame already in flight land before counting
    const n = ofType(daemon, "frame").length;
    await sleep(1_500); // absence window: no frame after the redial
    expect(ofType(daemon, "frame").length).toBe(n);
  });
});
