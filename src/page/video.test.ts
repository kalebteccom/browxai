// Unit tests for the session video recording primitives.
//
// Strategy: covers path resolution + state machine + finalize-on-close
// orchestration. A fake Playwright `Page.video()` records every `saveAs`
// call. The real .webm landing on disk is a context-close concern — left
// to keystone / integration coverage.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newVideoRecorderState,
  defaultVideoFilename,
  resolveVideoTargetPath,
  resolveVideoStagingDir,
  buildRecordVideoOption,
  assertVideoSupported,
  stopVideo,
  finalizeVideoOnClose,
  readVideoIfReady,
  VIDEO_INLINE_CAP_BYTES,
} from "./video.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "browx-video-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("defaultVideoFilename", () => {
  it.each([
    {
      name: "uses ISO timestamp with colon/dot stripped + safe session id",
      id: "agent-a",
      at: "2026-06-08T12:34:56.789Z",
      expected: /^agent-a-2026-06-08T12-34-56-789Z\.webm$/,
    },
    {
      name: "scrubs unsafe characters in the session id",
      id: "bad/id:with*chars",
      at: "2026-06-08T12:00:00.000Z",
      expected: /^bad_id_with_chars-.*\.webm$/,
    },
  ])("$name", ({ id, at, expected }) => {
    expect(defaultVideoFilename(id, new Date(at))).toMatch(expected);
  });
});

describe("resolveVideoTargetPath (workspace-rooted)", () => {
  it("resolves an explicit workspace-relative path under the workspace root", () => {
    const p = resolveVideoTargetPath(ws, "session-x", "captures/run1.webm", "open_session");
    expect(p).toBe(join(ws, "captures/run1.webm"));
    expect(existsSync(join(ws, "captures"))).toBe(true);
  });

  it("falls back to `<workspace>/videos/<auto>.webm` when no path is given", () => {
    const p = resolveVideoTargetPath(ws, "session-x", undefined, "open_session");
    expect(p.startsWith(join(ws, "videos") + "/")).toBe(true);
    expect(p.endsWith(".webm")).toBe(true);
    expect(existsSync(join(ws, "videos"))).toBe(true);
  });

  it("rejects path traversal outside the workspace", () => {
    expect(() => resolveVideoTargetPath(ws, "s", "../escape.webm", "open_session")).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
    expect(() => resolveVideoTargetPath(ws, "s", "/etc/leak.webm", "open_session")).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
  });
});

describe("resolveVideoStagingDir", () => {
  it.each([
    {
      name: "creates a per-session staging dir under `videos/.staging/`",
      id: "session-x",
      dir: "videos/.staging/session-x-2026-06-08T12-00-00-000Z",
    },
    {
      name: "scrubs unsafe characters in the session id",
      id: "bad/id:with*chars",
      dir: "videos/.staging/bad_id_with_chars-2026-06-08T12-00-00-000Z",
    },
  ])("$name", ({ id, dir }) => {
    const d = resolveVideoStagingDir(ws, id, new Date("2026-06-08T12:00:00.000Z"));
    expect(d).toBe(join(ws, dir));
    expect(existsSync(d)).toBe(true);
  });
});

describe("buildRecordVideoOption (open_session({recordVideo}))", () => {
  it("builds a Playwright-shaped recordVideo option with sensible defaults", () => {
    const r = buildRecordVideoOption(ws, "agent-a", {});
    expect(r.targetPath.startsWith(join(ws, "videos") + "/")).toBe(true);
    expect(r.targetPath.endsWith(".webm")).toBe(true);
    expect(r.stagingDir.startsWith(join(ws, "videos/.staging/"))).toBe(true);
    expect(r.recordVideo.dir).toBe(r.stagingDir);
    expect(r.recordVideo.size).toBeUndefined();
  });

  it("honours explicit path + size", () => {
    const r = buildRecordVideoOption(ws, "agent-a", {
      path: "captures/run.webm",
      size: { width: 1280, height: 720 },
    });
    expect(r.targetPath).toBe(join(ws, "captures/run.webm"));
    expect(r.recordVideo.size).toEqual({ width: 1280, height: 720 });
    expect(r.size).toEqual({ width: 1280, height: 720 });
  });
});

describe("assertVideoSupported (BYOB refusal)", () => {
  it("refuses on attached / BYOB sessions cleanly", () => {
    const r = assertVideoSupported({ mode: "attached" });
    expect(r).not.toBeNull();
    expect(r!.error).toMatch(/not supported on attached/);
    expect(r!.hint).toMatch(/open a managed session/);
  });

  it("returns null on managed persistent + incognito (supported)", () => {
    expect(assertVideoSupported({ mode: "persistent" })).toBeNull();
    expect(assertVideoSupported({ mode: "incognito" })).toBeNull();
  });
});

describe("stopVideo state machine", () => {
  it("is a no-op + wasActive:false when no recorder is active", () => {
    const state = newVideoRecorderState();
    const r = stopVideo(state);
    expect(r.wasActive).toBe(false);
    expect(r.pendingFinalize).toBe(false);
    expect(state.pendingFinalize).toBe(false);
  });

  it("marks pendingFinalize:true on an active recorder + carries target path", () => {
    const state = newVideoRecorderState();
    state.active = true;
    state.targetPath = join(ws, "videos/run.webm");
    const r = stopVideo(state);
    expect(r.wasActive).toBe(true);
    expect(r.pendingFinalize).toBe(true);
    expect(r.finalized).toBe(false);
    expect(r.targetPath).toBe(state.targetPath);
    expect(state.pendingFinalize).toBe(true);
    // finalized only flips on `finalizeVideoOnClose` after context.close
    expect(state.finalized).toBe(false);
  });
});

/** Minimal fake `Page.video()` — records every `saveAs` call. */
function fakePageWithVideo(
  opts: { savePath?: string; throwsOnSaveAs?: boolean; nullVideo?: boolean } = {},
) {
  const saveAsCalls: string[] = [];
  const video = opts.nullVideo
    ? null
    : {
        saveAs: vi.fn(async (p: string) => {
          saveAsCalls.push(p);
          if (opts.throwsOnSaveAs) throw new Error("simulated saveAs failure");
          if (opts.savePath) writeFileSync(opts.savePath, "fake-webm-bytes");
        }),
      };
  const page = {
    video: () => video,
  } as unknown as import("playwright-core").Page;
  return { page, saveAsCalls };
}

describe("finalizeVideoOnClose", () => {
  it("calls page.video().saveAs(targetPath) and flips finalized", async () => {
    mkdirSync(join(ws, "videos"));
    const target = join(ws, "videos/final.webm");
    const { page, saveAsCalls } = fakePageWithVideo({ savePath: target });
    const state = newVideoRecorderState();
    state.active = true;
    state.targetPath = target;
    await finalizeVideoOnClose(page, state);
    expect(saveAsCalls).toEqual([target]);
    expect(state.finalized).toBe(true);
  });

  it.each([
    { name: "the recorder isn't active", active: false, nullVideo: false },
    { name: "page.video() is null (best-effort)", active: true, nullVideo: true },
  ])("is a no-op when $name", async ({ active, nullVideo }) => {
    const { page, saveAsCalls } = fakePageWithVideo({ nullVideo });
    const state = newVideoRecorderState();
    state.active = active;
    state.targetPath = join(ws, "videos/missing.webm");
    await finalizeVideoOnClose(page, state);
    expect(saveAsCalls).toEqual([]);
    expect(state.finalized).toBe(false);
  });

  it("swallows saveAs errors and does NOT flip finalized (teardown must not throw)", async () => {
    const { page } = fakePageWithVideo({ throwsOnSaveAs: true });
    const state = newVideoRecorderState();
    state.active = true;
    state.targetPath = join(ws, "videos/will-fail.webm");
    await expect(finalizeVideoOnClose(page, state)).resolves.toBeUndefined();
    expect(state.finalized).toBe(false);
  });
});

describe("readVideoIfReady (get-before-stop + inline-vs-path)", () => {
  it("returns exists:false when the file is not yet on disk (the get-before-stop case)", () => {
    const r = readVideoIfReady(join(ws, "videos/missing.webm"));
    expect(r.exists).toBe(false);
    expect(r.path).toBe(join(ws, "videos/missing.webm"));
    expect(r.inlineBase64).toBeUndefined();
  });

  it('returns path + size when format="path"', () => {
    const p = join(ws, "ready.webm");
    writeFileSync(p, "abcdef");
    const r = readVideoIfReady(p, "path");
    expect(r.exists).toBe(true);
    expect(r.bytes).toBe(6);
    expect(r.inlineBase64).toBeUndefined();
  });

  it('inlines as base64 when format="bytes" and under the cap', () => {
    const p = join(ws, "small.webm");
    writeFileSync(p, "abcd");
    const r = readVideoIfReady(p, "bytes");
    expect(r.exists).toBe(true);
    expect(r.inlineBase64).toBe(Buffer.from("abcd").toString("base64"));
    expect(r.tooLargeToInline).toBeUndefined();
  });

  it('returns tooLargeToInline:true when format="bytes" and over the cap', () => {
    const p = join(ws, "big.webm");
    const big = Buffer.alloc(VIDEO_INLINE_CAP_BYTES + 64, "x");
    writeFileSync(p, big);
    const r = readVideoIfReady(p, "bytes");
    expect(r.exists).toBe(true);
    expect(r.tooLargeToInline).toBe(true);
    expect(r.inlineBase64).toBeUndefined();
  });
});
