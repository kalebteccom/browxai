import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { onInterrupt, removeDir, runSmoke, type SignalHost } from "./init-smoke.js";

function fakeHost(): SignalHost & { emitter: EventEmitter; exits: number[] } {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  return {
    emitter,
    exits,
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    exit: (code) => void exits.push(code),
  };
}

describe("runSmoke", () => {
  it("says what to do when the built cli is missing, without starting anything", async () => {
    const res = await runSmoke({ distCli: join(tmpdir(), "browxai-no-such-dir", "cli.js") });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/^error: /);
    expect(res.message).toContain("pnpm build");
    expect(res.message).toContain("--no-smoke");
  });
});

describe("onInterrupt", () => {
  it("removes the temp dir and exits 130 on Ctrl+C", () => {
    const dir = mkdtempSync(join(tmpdir(), "browxai-smoke-"));
    const host = fakeHost();
    onInterrupt(() => removeDir(dir), host);
    host.emitter.emit("SIGINT", "SIGINT");
    expect(existsSync(dir)).toBe(false);
    expect(host.exits).toEqual([130]);
    expect(host.emitter.listenerCount("SIGINT")).toBe(0);
    expect(host.emitter.listenerCount("SIGTERM")).toBe(0);
  });

  it("exits 143 on SIGTERM", () => {
    const host = fakeHost();
    let ran = 0;
    onInterrupt(() => void ran++, host);
    host.emitter.emit("SIGTERM", "SIGTERM");
    expect(ran).toBe(1);
    expect(host.exits).toEqual([143]);
  });

  it("does nothing once switched off", () => {
    const host = fakeHost();
    let ran = 0;
    const off = onInterrupt(() => void ran++, host);
    off();
    host.emitter.emit("SIGINT", "SIGINT");
    expect(ran).toBe(0);
    expect(host.exits).toEqual([]);
  });
});

describe("removeDir", () => {
  const failWith = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it("ignores a dir that is still busy", () => {
    expect(() => removeDir("/x", failWith("EBUSY"))).not.toThrow();
    expect(() => removeDir("/x", failWith("EPERM"))).not.toThrow();
  });

  it("passes other errors on", () => {
    expect(() => removeDir("/x", failWith("EIO"))).toThrow("EIO");
  });
});
