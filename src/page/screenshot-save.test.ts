import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { screenshotSave } from "./screenshot-save.js";

/** Synthetic PNG-ish payload — the helper writes bytes verbatim, so an
 *  arbitrary buffer suffices. Test the disk-write contract, not the encoder. */
function fakePng(size = 64): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  return b;
}

let WS: string;
beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), "browx-screenshot-"));
});
afterEach(() => {
  rmSync(WS, { recursive: true, force: true });
});

describe("screenshotSave", () => {
  it("writes the buffer to a workspace-rooted path and reports bytes/format/fullPage", () => {
    const buf = fakePng(256);
    const r = screenshotSave(buf, WS, { path: "shot.png", format: "png", fullPage: false });
    expect(r.ok).toBe(true);
    expect(r.path).toBe(join(WS, "shot.png"));
    expect(r.bytes).toBe(256);
    expect(r.format).toBe("png");
    expect(r.fullPage).toBe(false);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path).equals(buf)).toBe(true);
  });

  it("records fullPage:true when supplied", () => {
    const r = screenshotSave(fakePng(), WS, { path: "full.png", format: "png", fullPage: true });
    expect(r.fullPage).toBe(true);
  });

  it("records jpeg format faithfully", () => {
    const r = screenshotSave(fakePng(), WS, { path: "out.jpg", format: "jpeg", fullPage: false });
    expect(r.format).toBe("jpeg");
  });

  it("creates the parent directory if missing", () => {
    const r = screenshotSave(fakePng(), WS, {
      path: "nested/deeply/out.png", format: "png", fullPage: false,
    });
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toBe(join(WS, "nested/deeply/out.png"));
  });

  it("rejects a path that escapes the workspace via `..`", () => {
    expect(() =>
      screenshotSave(fakePng(), WS, {
        path: "../../etc/escape.png", format: "png", fullPage: false,
      }),
    ).toThrow(/\$BROWX_WORKSPACE/);
  });

  it("rejects an absolute path outside the workspace", () => {
    expect(() =>
      screenshotSave(fakePng(), WS, {
        path: "/tmp/elsewhere.png", format: "png", fullPage: false,
      }),
    ).toThrow(/\$BROWX_WORKSPACE/);
  });
});
