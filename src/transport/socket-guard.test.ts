import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOwnSocket,
  connectOwnSocket,
  isPipePath,
  SocketGuardError,
  type SocketGuardDeps,
} from "./socket-guard.js";

/** A stat result with only what the guard reads. */
function fakeStat(over: {
  socket?: boolean;
  symlink?: boolean;
  uid?: number;
  mode?: number;
}): Stats {
  return {
    isSocket: () => over.socket ?? true,
    isSymbolicLink: () => over.symlink ?? false,
    uid: over.uid ?? 501,
    mode: over.mode ?? 0o140600,
  } as unknown as Stats;
}

const deps = (stat: Stats, over: Partial<SocketGuardDeps> = {}): SocketGuardDeps => ({
  lstat: () => stat,
  uid: () => 501,
  platform: "linux",
  ...over,
});

describe("assertOwnSocket", () => {
  it("passes a socket owned by this user at mode 600", () => {
    expect(() => assertOwnSocket("/run/b.sock", deps(fakeStat({})))).not.toThrow();
  });

  it.each([
    ["a symbolic link", fakeStat({ symlink: true, socket: false }), "is a symbolic link"],
    ["a regular file", fakeStat({ socket: false }), "is not a socket"],
    ["another user's socket", fakeStat({ uid: 0 }), "owned by another user (uid 0)"],
    ["a group-writable socket", fakeStat({ mode: 0o140660 }), "has mode 660"],
    ["a world-readable socket", fakeStat({ mode: 0o140604 }), "has mode 604"],
    ["a socket at the default mode", fakeStat({ mode: 0o140755 }), "has mode 755"],
  ])("refuses %s and says why", (_what, stat, reason) => {
    const check = () => assertOwnSocket("/run/b.sock", deps(stat));
    expect(check).toThrow(SocketGuardError);
    expect(check).toThrow(reason);
    expect(check).toThrow("refusing to connect: /run/b.sock");
  });

  it("throws the lstat error as is when nothing is at the path", () => {
    const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const check = () =>
      assertOwnSocket(
        "/run/none.sock",
        deps(fakeStat({}), {
          lstat: () => {
            throw missing;
          },
        }),
      );
    expect(check).toThrow(missing);
    expect(check).not.toThrow(SocketGuardError);
  });

  it("does not check a pipe path, any path on Windows, or a platform with no user id", () => {
    const never = (): Stats => {
      throw new Error("lstat must not be called");
    };
    const bad = fakeStat({ socket: false });
    expect(() =>
      assertOwnSocket("\\\\.\\pipe\\browxai", deps(bad, { lstat: never })),
    ).not.toThrow();
    expect(() =>
      assertOwnSocket("C:\\b.sock", deps(bad, { lstat: never, platform: "win32" })),
    ).not.toThrow();
    expect(() =>
      assertOwnSocket("/run/b.sock", deps(bad, { lstat: never, uid: () => undefined })),
    ).not.toThrow();
  });

  it("recognises Windows pipe names", () => {
    expect(isPipePath("\\\\.\\pipe\\browxai")).toBe(true);
    expect(isPipePath("//./pipe/browxai")).toBe(true);
    expect(isPipePath("/tmp/browxai.sock")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("connectOwnSocket against real files", () => {
  let dir: string;
  let path: string;
  let server: Server;
  let accepted: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "browx-guard-"));
    path = join(dir, "d.sock");
    accepted = 0;
    server = createServer((socket) => {
      accepted++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    chmodSync(path, 0o600);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("connects to a socket this user owns at mode 600", async () => {
    const socket = await connectOwnSocket(path);
    expect(socket.destroyed).toBe(false);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accepted).toBe(1);
  });

  it("refuses a socket that group or others can reach, and opens no connection", async () => {
    chmodSync(path, 0o666);
    await expect(connectOwnSocket(path)).rejects.toThrow(SocketGuardError);
    await expect(connectOwnSocket(path)).rejects.toThrow("has mode 666");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accepted).toBe(0);
  });

  it("refuses a symbolic link to the socket", async () => {
    const link = join(dir, "link.sock");
    symlinkSync(path, link);
    await expect(connectOwnSocket(link)).rejects.toThrow("is a symbolic link");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accepted).toBe(0);
  });

  it("refuses a regular file", async () => {
    const file = join(dir, "plain");
    writeFileSync(file, "");
    await expect(connectOwnSocket(file)).rejects.toThrow("is not a socket");
  });

  it("rejects with ENOENT when nothing is at the path", async () => {
    await expect(connectOwnSocket(join(dir, "none.sock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
