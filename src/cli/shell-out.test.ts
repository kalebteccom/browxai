import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOutPath, writeImage } from "./shell-out.js";

const PIXELS = Buffer.from("fake image bytes");
const B64 = PIXELS.toString("base64");

describe("--out", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brx-shell-out-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a new file in a directory that exists", () => {
    expect(checkOutPath(join(dir, "shot.png"), false)).toBeUndefined();
  });

  it("refuses a directory that does not exist", () => {
    expect(checkOutPath(join(dir, "no-such", "shot.png"), false)).toContain("does not exist");
    expect(checkOutPath(join(dir, "no-such", "shot.png"), true)).toContain("does not exist");
  });

  it("refuses an existing file unless force is given, before anything runs", () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, "keep me");
    expect(checkOutPath(path, false)).toContain("already exists");
    expect(checkOutPath(path, false)).toContain("--force");
    expect(checkOutPath(path, true)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("keep me");
  });

  it("counts a dangling symlink as occupied", () => {
    const link = join(dir, "link.png");
    symlinkSync(join(dir, "nowhere"), link);
    expect(checkOutPath(link, false)).toContain("already exists");
  });

  it("writes the decoded bytes, owner-only", () => {
    const path = join(dir, "shot.png");
    expect(writeImage(path, B64, false)).toBeUndefined();
    expect(readFileSync(path).equals(PIXELS)).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("does not overwrite a file that appeared after the check, without force", () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, "keep me");
    expect(writeImage(path, B64, false)).toContain("already exists");
    expect(readFileSync(path, "utf8")).toBe("keep me");
  });

  it("overwrites with force", () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, "old");
    expect(writeImage(path, B64, true)).toBeUndefined();
    expect(readFileSync(path).equals(PIXELS)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "with force, an existing 0644 file ends up owner-only",
    () => {
      const path = join(dir, "shot.png");
      writeFileSync(path, "old", { mode: 0o644 });
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o077).not.toBe(0);
      expect(writeImage(path, B64, true)).toBeUndefined();
      expect(readFileSync(path).equals(PIXELS)).toBe(true);
      expect(statSync(path).mode & 0o077).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "with force, a symlink is replaced and its target is left alone",
    () => {
      const target = join(dir, "target.txt");
      const link = join(dir, "link.png");
      writeFileSync(target, "keep me");
      symlinkSync(target, link);
      expect(checkOutPath(link, true)).toBeUndefined();
      expect(writeImage(link, B64, true)).toBeUndefined();
      expect(readFileSync(target, "utf8")).toBe("keep me");
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      expect(readFileSync(link).equals(PIXELS)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "with force, a dangling symlink is replaced and nothing is created where it pointed",
    () => {
      const elsewhere = join(dir, "created-by-follow.png");
      const link = join(dir, "dangling.png");
      symlinkSync(elsewhere, link);
      expect(writeImage(link, B64, true)).toBeUndefined();
      expect(existsSync(elsewhere)).toBe(false);
      expect(lstatSync(link).isFile()).toBe(true);
    },
  );

  it("refuses a directory with or without force, and leaves it", () => {
    const path = join(dir, "folder");
    mkdirSync(path);
    expect(checkOutPath(path, false)).toContain("is a directory");
    expect(checkOutPath(path, true)).toContain("is a directory");
    expect(writeImage(path, B64, true)).toContain("is a directory");
    expect(lstatSync(path).isDirectory()).toBe(true);
  });

  it("reports a write it cannot make", () => {
    expect(writeImage(join(dir, "no-such", "shot.png"), B64, false)).toContain("could not write");
  });
});
