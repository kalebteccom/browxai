// A per-session storage dir, the auth-state dir and the snapshot dir are fixed
// by the server, but a link inside the workspace can still point one of them
// somewhere else. Each writer checks the real path before it writes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Download } from "playwright-core";
import { ArtifactsRegistry } from "./artifacts.js";
import { authSave } from "./storage.js";
import { snapshotProfile } from "./profile-snapshot.js";
import { attachDownloadCapture, DownloadsRegistry } from "../page/downloads.js";
import { resolveHarPath } from "../page/har.js";
import { resolveVideoStagingDir, resolveVideoTargetPath } from "../page/video.js";

let base: string;
let root: string;
let outside: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "browx-write-contain-"));
  root = join(base, "ws");
  outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const OUTSIDE = /outside \$BROWX_WORKSPACE/;

describe("per-session storage writers", () => {
  it("artifact_save refuses when .artifacts is a link out, and writes when it is not", () => {
    symlinkSync(outside, join(root, ".artifacts"));
    const reg = new ArtifactsRegistry(join(root, ".artifacts", "s1"), root);
    expect(() => reg.save("a.txt", "x")).toThrow(OUTSIDE);
    expect(readdirSync(outside)).toEqual([]);

    rmSync(join(root, ".artifacts"));
    const ok = new ArtifactsRegistry(join(root, ".artifacts", "s1"), root);
    expect(ok.save("a.txt", "x").name).toBe("a.txt");
  });

  it("downloads capture refuses when .downloads is a link out", async () => {
    symlinkSync(outside, join(root, ".downloads"));
    const reg = new DownloadsRegistry(join(root, ".downloads", "s1"), root);
    reg.captureOn = true;
    let handler: ((d: Download) => void) | undefined;
    const context = {
      on: (_event: string, h: (d: Download) => void) => {
        handler = h;
      },
    } as unknown as BrowserContext;
    attachDownloadCapture(context, reg);
    const saveAs = vi.fn(async () => undefined);
    handler!({
      suggestedFilename: () => "report.csv",
      saveAs,
      cancel: async () => undefined,
    } as unknown as Download);
    await new Promise((r) => setTimeout(r, 50));
    expect(saveAs).not.toHaveBeenCalled();
    expect(reg.list()).toHaveLength(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("auth_save refuses when .auth-states is a link out", async () => {
    symlinkSync(outside, join(root, ".auth-states"));
    const context = {
      storageState: async () => ({ cookies: [], origins: [] }),
    } as unknown as BrowserContext;
    await expect(authSave(context, root, "slot")).rejects.toThrow(OUTSIDE);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("profile_snapshot refuses when profile-snapshots is a link out", () => {
    mkdirSync(join(root, "profile"));
    symlinkSync(outside, join(root, "profile-snapshots"));
    expect(() => snapshotProfile(root, undefined, "clean")).toThrow(OUTSIDE);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("default HAR and video locations", () => {
  it("a default HAR path refuses when har/ is a link out", () => {
    symlinkSync(outside, join(root, "har"));
    expect(() => resolveHarPath(root, "s1", undefined, "start_har")).toThrow(OUTSIDE);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("video target and staging dir refuse when videos/ is a link out", () => {
    symlinkSync(outside, join(root, "videos"));
    expect(() => resolveVideoTargetPath(root, "s1", undefined, "open_session")).toThrow(OUTSIDE);
    expect(() => resolveVideoStagingDir(root, "s1")).toThrow(OUTSIDE);
    expect(existsSync(join(outside, ".staging"))).toBe(false);
  });
});
