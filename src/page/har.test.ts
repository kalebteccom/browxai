// Unit tests for the HAR record/replay primitives.
//
// Strategy: a fake `BrowserContext` records every `routeFromHAR` /
// `unrouteAll` call. The real Playwright pipeline writes the .har on
// context.close(); we cover the routing plumb + state machine here, and
// leave the actual file write to keystone/integration coverage.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newHarRecorderState,
  startHar,
  stopHar,
  defaultHarFilename,
  resolveHarPath,
  resolveHarReplayPaths,
  buildRecordHarOption,
  applyHarReplay,
  readHarIfSmall,
  HAR_INLINE_CAP_BYTES,
} from "./har.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "browx-har-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

/** Minimal fake BrowserContext — records every HAR-related call. */
function fakeContext() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ctx = {
    routeFromHAR: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "routeFromHAR", args });
    }),
    unrouteAll: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: "unrouteAll", args });
    }),
  } as unknown as import("playwright-core").BrowserContext;
  return { ctx, calls };
}

describe("defaultHarFilename", () => {
  it("uses ISO timestamp with colon/dot stripped + safe session id", () => {
    const name = defaultHarFilename("agent-a", new Date("2026-05-26T12:34:56.789Z"));
    expect(name).toBe("agent-a-2026-05-26T12-34-56-789Z.har");
  });

  it("scrubs unsafe characters in the session id", () => {
    const name = defaultHarFilename("bad/id:with*chars", new Date("2026-05-26T12:00:00.000Z"));
    expect(name).toMatch(/^bad_id_with_chars-/);
    expect(name).toMatch(/\.har$/);
  });
});

describe("resolveHarPath (workspace-rooted)", () => {
  it("resolves an explicit workspace-relative path under the workspace root", () => {
    const p = resolveHarPath(ws, "session-x", "captures/run1.har", "start_har");
    expect(p).toBe(join(ws, "captures/run1.har"));
    // parent dir is created on demand
    expect(existsSync(join(ws, "captures"))).toBe(true);
  });

  it("falls back to `<workspace>/har/<auto>.har` when no path is given", () => {
    const p = resolveHarPath(ws, "session-x", undefined, "start_har");
    expect(p.startsWith(join(ws, "har") + "/")).toBe(true);
    expect(p.endsWith(".har")).toBe(true);
    expect(existsSync(join(ws, "har"))).toBe(true);
  });

  it("rejects path traversal outside the workspace", () => {
    expect(() => resolveHarPath(ws, "s", "../escape.har", "start_har")).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
    expect(() => resolveHarPath(ws, "s", "/etc/passwd", "start_har")).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
  });
});

describe("resolveHarReplayPaths", () => {
  it("rejects empty / non-string entries", () => {
    expect(() => resolveHarReplayPaths(ws, [""], "open_session")).toThrow(
      /non-empty workspace-rooted/,
    );
  });

  it("rejects missing files (no silent fallback to network on a typo)", () => {
    expect(() => resolveHarReplayPaths(ws, ["captures/nope.har"], "open_session")).toThrow(
      /HAR replay file not found/,
    );
  });

  it("rejects path traversal outside the workspace", () => {
    expect(() => resolveHarReplayPaths(ws, ["../escape.har"], "open_session")).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
  });

  it("returns workspace-absolute paths for every entry that exists", () => {
    mkdirSync(join(ws, "captures"));
    writeFileSync(join(ws, "captures/a.har"), "{}");
    writeFileSync(join(ws, "captures/b.har"), "{}");
    const r = resolveHarReplayPaths(ws, ["captures/a.har", "captures/b.har"], "open_session");
    expect(r).toEqual([join(ws, "captures/a.har"), join(ws, "captures/b.har")]);
  });
});

describe("startHar (happy path)", () => {
  it("wires routeFromHAR(update:true) and records active state", async () => {
    const { ctx, calls } = fakeContext();
    const state = newHarRecorderState();
    const r = await startHar(ctx, state, ws, "agent-a", { path: "run1.har" });
    expect(r.path).toBe(join(ws, "run1.har"));
    expect(r.mode).toBe("full");
    expect(r.content).toBe("embed");
    expect(r.replacedPrior).toBe(false);
    expect(state.active).toBe(true);
    expect(state.path).toBe(join(ws, "run1.har"));
    expect(calls.filter((c) => c.method === "routeFromHAR")).toHaveLength(1);
    const [, options] = calls[0]!.args as [string, Record<string, unknown>];
    expect(options.update).toBe(true);
    expect(options.updateMode).toBe("full");
    expect(options.updateContent).toBe("embed");
  });

  it("auto-names the .har under <workspace>/har/ when no path is supplied", async () => {
    const { ctx } = fakeContext();
    const state = newHarRecorderState();
    const r = await startHar(ctx, state, ws, "agent-a");
    expect(r.path.startsWith(join(ws, "har") + "/")).toBe(true);
    expect(r.path.endsWith(".har")).toBe(true);
  });

  it("honours mode + content overrides", async () => {
    const { ctx, calls } = fakeContext();
    const state = newHarRecorderState();
    await startHar(ctx, state, ws, "agent-a", {
      path: "minimal.har",
      mode: "minimal",
      content: "attach",
      urlFilter: "**/*.api",
    });
    const [, options] = calls[0]!.args as [string, Record<string, unknown>];
    expect(options.updateMode).toBe("minimal");
    expect(options.updateContent).toBe("attach");
    expect(options.url).toBe("**/*.api");
  });

  it("drops updateContent when caller asks to omit bodies", async () => {
    const { ctx, calls } = fakeContext();
    const state = newHarRecorderState();
    await startHar(ctx, state, ws, "agent-a", { path: "noBodies.har", content: "omit" });
    const [, options] = calls[0]!.args as [string, Record<string, unknown>];
    expect(options.updateContent).toBeUndefined();
  });
});

describe("startHar (workspace-escape rejection)", () => {
  it("rejects a path that escapes the workspace", async () => {
    const { ctx } = fakeContext();
    const state = newHarRecorderState();
    await expect(startHar(ctx, state, ws, "s", { path: "../escape.har" })).rejects.toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
    expect(state.active).toBe(false);
  });

  it("rejects an absolute path pointing outside the workspace", async () => {
    const { ctx } = fakeContext();
    const state = newHarRecorderState();
    await expect(startHar(ctx, state, ws, "s", { path: "/etc/passwd" })).rejects.toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
  });

  it("refuses to start over an active native-record session", async () => {
    const { ctx } = fakeContext();
    const state = newHarRecorderState();
    state.active = true;
    state.nativeRecord = true;
    state.path = join(ws, "creation.har");
    await expect(startHar(ctx, state, ws, "s", { path: "again.har" })).rejects.toThrow(
      /wired at session creation/,
    );
  });
});

describe("startHar (re-recording within same session)", () => {
  it("transparently stops the prior recorder before swapping targets", async () => {
    const { ctx, calls } = fakeContext();
    const state = newHarRecorderState();
    await startHar(ctx, state, ws, "agent-a", { path: "first.har" });
    expect(state.path).toBe(join(ws, "first.har"));

    const r2 = await startHar(ctx, state, ws, "agent-a", { path: "second.har" });
    expect(r2.replacedPrior).toBe(true);
    expect(state.path).toBe(join(ws, "second.har"));
    // The prior recorder was flushed by an `unrouteAll` between the two routeFromHAR calls.
    const order = calls.map((c) => c.method);
    expect(order).toEqual(["routeFromHAR", "unrouteAll", "routeFromHAR"]);
  });

  it("clears state cleanly after stop, then a fresh start works", async () => {
    const { ctx, calls } = fakeContext();
    const state = newHarRecorderState();
    await startHar(ctx, state, ws, "agent-a", { path: "first.har" });
    const stopped = await stopHar(ctx, state);
    expect(stopped.wasActive).toBe(true);
    expect(stopped.finalized).toBe(false);
    expect(state.active).toBe(false);

    const r2 = await startHar(ctx, state, ws, "agent-a", { path: "second.har" });
    expect(r2.replacedPrior).toBe(false);
    expect(state.active).toBe(true);
    expect(state.path).toBe(join(ws, "second.har"));
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(["routeFromHAR", "unrouteAll", "routeFromHAR"]);
  });
});

describe("stopHar", () => {
  it("is a no-op + wasActive:false when no recorder is active", async () => {
    const { ctx, calls } = fakeContext();
    const state = newHarRecorderState();
    const r = await stopHar(ctx, state);
    expect(r.wasActive).toBe(false);
    expect(r.finalized).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the nativeRecord constraint instead of silently no-opping", async () => {
    const { ctx, calls } = fakeContext();
    const state = newHarRecorderState();
    state.active = true;
    state.nativeRecord = true;
    state.path = join(ws, "creation.har");
    const r = await stopHar(ctx, state);
    expect(r.wasActive).toBe(true);
    expect(r.nativeRecord).toBe(true);
    expect(r.finalized).toBe(false);
    expect(r.path).toBe(join(ws, "creation.har"));
    // No unroute fired — that's the whole point: we can't undo the native primitive mid-session.
    expect(calls).toHaveLength(0);
  });

  it("calls unrouteAll and clears active but keeps path discoverable", async () => {
    const { ctx } = fakeContext();
    const state = newHarRecorderState();
    await startHar(ctx, state, ws, "s", { path: "run.har" });
    const r = await stopHar(ctx, state);
    expect(r.wasActive).toBe(true);
    expect(r.path).toBe(join(ws, "run.har"));
    expect(state.active).toBe(false);
    expect(state.path).toBe(join(ws, "run.har"));
  });
});

describe("readHarIfSmall (inline-vs-path threshold)", () => {
  it("returns undefined when the file does not exist (HAR not yet finalized)", () => {
    expect(readHarIfSmall(join(ws, "missing.har"))).toBeUndefined();
  });

  it("inlines a file under the cap", () => {
    const p = join(ws, "small.har");
    const body = JSON.stringify({ log: { entries: [] } });
    writeFileSync(p, body);
    expect(readHarIfSmall(p)).toBe(body);
  });

  it("returns undefined when the file is over the inline cap", () => {
    const p = join(ws, "big.har");
    // Construct a payload safely over the cap.
    const big = "x".repeat(HAR_INLINE_CAP_BYTES + 1024);
    writeFileSync(p, big);
    expect(readHarIfSmall(p)).toBeUndefined();
  });

  it("respects a custom cap", () => {
    const p = join(ws, "tiny.har");
    writeFileSync(p, "abcd");
    expect(readHarIfSmall(p, 2)).toBeUndefined();
    expect(readHarIfSmall(p, 1024)).toBe("abcd");
  });
});

describe("applyHarReplay", () => {
  it("wires each file with notFound:fallback", async () => {
    const { ctx, calls } = fakeContext();
    mkdirSync(join(ws, "captures"));
    writeFileSync(join(ws, "captures/a.har"), "{}");
    writeFileSync(join(ws, "captures/b.har"), "{}");
    await applyHarReplay(ctx, [join(ws, "captures/a.har"), join(ws, "captures/b.har")]);
    expect(calls.filter((c) => c.method === "routeFromHAR")).toHaveLength(2);
    for (const c of calls) {
      const [, options] = c.args as [string, Record<string, unknown>];
      expect(options.notFound).toBe("fallback");
    }
  });
});

describe("buildRecordHarOption (open_session({har}))", () => {
  it("builds a Playwright-shaped recordHar option with sensible defaults", () => {
    const r = buildRecordHarOption(ws, "agent-a", { path: "creation.har" });
    expect(r.path).toBe(join(ws, "creation.har"));
    expect(r.mode).toBe("full");
    expect(r.content).toBe("embed");
    expect(r.recordHar.path).toBe(join(ws, "creation.har"));
    expect(r.recordHar.mode).toBe("full");
    expect(r.recordHar.content).toBe("embed");
  });

  it("rejects a path that escapes the workspace", () => {
    expect(() => buildRecordHarOption(ws, "s", { path: "../escape.har" })).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
  });
});
