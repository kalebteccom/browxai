// A `browxai serve` daemon started through the runtime launcher drains onto a
// new version: once `current` names another version and no client has been
// connected and no session open for 15 minutes, it asks to exit with 75 (RFC
// 0015, D11). The runtime is a temp directory and the clock is a fake, so the
// test waits no real minutes and starts no browser.
//
// Skipped on Windows: the test relies on POSIX socket file semantics.

import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDrainClock } from "../../src/cli/__fixtures__/drain-clock.js";
import {
  addVersion,
  tempRuntime,
  type TempRuntime,
} from "../../src/cli/__fixtures__/runtime-tree.js";
import { switchCurrent } from "../../src/cli/runtime-store.js";
import { startServeForTests } from "../../src/cli/serve.js";

const skipIfWindows = process.platform === "win32" ? describe.skip : describe;
const MIN = 60_000;

let workspace: string;
let rt: TempRuntime;
let handle: Awaited<ReturnType<typeof startServeForTests>> | undefined;
let socket: Socket | undefined;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-drain-"));
  process.env.BROWX_WORKSPACE = workspace;
  rt = tempRuntime();
  addVersion(rt.paths, "0.21.0");
  addVersion(rt.paths, "0.22.0");
  switchCurrent(rt.paths, "0.21.0");
});

afterEach(async () => {
  socket?.destroy();
  socket = undefined;
  await handle?.shutdown().catch(() => undefined);
  handle = undefined;
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
  rt.cleanup();
}, 30_000);

async function serve(env: NodeJS.ProcessEnv) {
  const { clock, advance } = fakeDrainClock();
  const exits: number[] = [];
  const socketPath = join(workspace, "browxai.sock");
  handle = await startServeForTests({
    socketPath,
    drain: { env, clock, onDrain: (code) => exits.push(code) },
  });
  return { socketPath, advance, exits, h: handle };
}

const RUNTIME_ENV = (root: string) => ({
  BROWX_RUNTIME_DIR: root,
  BROWX_RUNTIME_VERSION: "0.21.0",
});

skipIfWindows("browxai serve under the runtime launcher", () => {
  it("keeps running with a client connected, then exits 75 after 15 idle minutes", async () => {
    const { socketPath, advance, exits, h } = await serve(RUNTIME_ENV(rt.paths.root));
    switchCurrent(rt.paths, "0.22.0");
    socket = createConnection(socketPath);
    await vi.waitFor(() => expect(h.connections()).toBe(1), { timeout: 10_000 });
    advance(60 * MIN);
    expect(exits).toEqual([]);
    socket.destroy();
    await vi.waitFor(() => expect(h.connections()).toBe(0), { timeout: 10_000 });
    advance(14 * MIN);
    expect(exits).toEqual([]);
    advance(6 * MIN);
    expect(exits).toEqual([75]);
  }, 30_000);

  it("never exits while current names its own version", async () => {
    const { advance, exits } = await serve(RUNTIME_ENV(rt.paths.root));
    advance(24 * 60 * MIN);
    expect(exits).toEqual([]);
  }, 30_000);

  it("never exits with BROWX_RUNTIME_DAEMON_RESTART=off", async () => {
    const { advance, exits } = await serve({
      ...RUNTIME_ENV(rt.paths.root),
      BROWX_RUNTIME_DAEMON_RESTART: "off",
    });
    switchCurrent(rt.paths, "0.22.0");
    advance(24 * 60 * MIN);
    expect(exits).toEqual([]);
  }, 30_000);

  it("never exits outside the runtime", async () => {
    const { advance, exits } = await serve({});
    switchCurrent(rt.paths, "0.22.0");
    advance(24 * 60 * MIN);
    expect(exits).toEqual([]);
  }, 30_000);
});
