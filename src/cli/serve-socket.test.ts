import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  SocketPathError,
  isPipePath,
  listenPrivate,
  removeStaleSocket,
  resolveSocketPath,
} from "./serve-socket.js";

describe("serve socket path", () => {
  it("recognises Windows pipe names and leaves them as they are", () => {
    expect(isPipePath("\\\\.\\pipe\\browxai")).toBe(true);
    expect(isPipePath("//./pipe/browxai")).toBe(true);
    expect(isPipePath("/tmp/browxai.sock")).toBe(false);
    expect(isPipePath("browxai.sock")).toBe(false);
    expect(resolveSocketPath("\\\\.\\pipe\\browxai")).toBe("\\\\.\\pipe\\browxai");
  });

  it("resolves a relative path to an absolute one", () => {
    const resolved = resolveSocketPath("relative.sock");
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith("relative.sock")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("socket files in a temp directory", () => {
  let dir: string;
  const servers: Server[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brx-sock-"));
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when nothing is at the path", () => {
    expect(removeStaleSocket(join(dir, "none.sock"))).toBe(false);
  });

  it("removes a socket left at the path", async () => {
    const path = join(dir, "stale.sock");
    const server = createServer();
    servers.push(server);
    await listenPrivate(server, path);
    expect(removeStaleSocket(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    {
      label: "a regular file",
      make: (dir: string) => {
        const path = join(dir, "notes.txt");
        writeFileSync(path, "keep me");
        return { path, kept: path, content: "keep me", message: /not a socket/ };
      },
    },
    {
      label: "a directory",
      make: (dir: string) => {
        const path = join(dir, "folder");
        mkdirSync(path);
        return { path, kept: path, content: undefined, message: undefined };
      },
    },
    {
      // Refuses to follow the link: both the link and its target survive.
      label: "a symlink",
      make: (dir: string) => {
        const target = join(dir, "target.txt");
        const link = join(dir, "link.sock");
        writeFileSync(target, "keep me");
        symlinkSync(target, link);
        return { path: link, kept: target, content: "keep me", message: undefined };
      },
    },
  ])("refuses to remove $label, and leaves it intact", ({ make }) => {
    const { path, kept, content, message } = make(dir);
    expect(() => removeStaleSocket(path)).toThrow(SocketPathError);
    if (message) expect(() => removeStaleSocket(path)).toThrow(message);
    expect(existsSync(kept)).toBe(true);
    if (content !== undefined) expect(readFileSync(kept, "utf8")).toBe(content);
  });

  it("creates the socket owner-only, with no group or other access", async () => {
    const path = join(dir, "private.sock");
    const server = createServer();
    servers.push(server);
    await listenPrivate(server, path);
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("restores the umask after listening, on success and on failure", async () => {
    const before = process.umask();
    const server = createServer();
    servers.push(server);
    await listenPrivate(server, join(dir, "mask.sock"));
    expect(process.umask()).toBe(before);

    const failing = createServer();
    await expect(listenPrivate(failing, join(dir, "missing-dir", "x.sock"))).rejects.toThrow();
    expect(process.umask()).toBe(before);
  });
});
