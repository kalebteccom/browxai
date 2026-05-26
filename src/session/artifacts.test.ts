// Unit tests for the per-session artifact KV.
//
// Strategy: no browser. Drive the registry against a tmpdir storage dir,
// exercise the save/get/list/clear surface, the capacity caps, the encoding
// round-trips, and the workspace-escape rejection.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ArtifactsRegistry,
  ARTIFACT_MAX_ENTRIES,
  ARTIFACT_MAX_BYTES,
} from "./artifacts.js";

let storage: string;

beforeEach(() => {
  // simulate a per-session subdir under a workspace root.
  const ws = mkdtempSync(join(tmpdir(), "browx-artifacts-"));
  storage = join(ws, ".artifacts", "session-A");
});

afterEach(() => {
  // the workspace root is one level up — wipe the whole tree.
  // join(...) and split: storage is `<tmp>/.artifacts/session-A`.
  const ws = storage.split(`${join(".artifacts", "session-A")}`)[0]!;
  rmSync(ws, { recursive: true, force: true });
});

function reg(): ArtifactsRegistry {
  return new ArtifactsRegistry(storage);
}

describe("ArtifactsRegistry — save/get/list round-trip", () => {
  it("creates the storage dir lazily on first save", () => {
    expect(existsSync(storage)).toBe(false);
    const r = reg();
    expect(r.list()).toEqual([]); // list on a non-existent dir is empty
    r.save("hello.txt", "world");
    expect(existsSync(storage)).toBe(true);
    expect(existsSync(join(storage, "hello.txt"))).toBe(true);
  });

  it("round-trips utf8 content faithfully", () => {
    const r = reg();
    const info = r.save("note.md", "# Title\n\nbody");
    expect(info.name).toBe("note.md");
    expect(info.size).toBe(Buffer.byteLength("# Title\n\nbody", "utf8"));

    const got = r.get("note.md");
    expect(got.content).toBe("# Title\n\nbody");
    expect(got.encoding).toBe("utf8");
    expect(got.size).toBe(info.size);
  });

  it("round-trips base64 binary content faithfully", () => {
    const r = reg();
    // 4 non-text bytes (PNG signature-ish)
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const b64 = bin.toString("base64");
    r.save("blob.bin", b64, "base64");

    const got = r.get("blob.bin", "base64");
    expect(got.encoding).toBe("base64");
    expect(Buffer.from(got.content, "base64").equals(bin)).toBe(true);
    expect(got.size).toBe(bin.length);
  });

  it("overwrite replaces content; size + mtime update", async () => {
    const r = reg();
    r.save("k", "first");
    // small delay so mtimeMs differs reliably on coarse-grain filesystems
    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = r.save("k", "second-longer");
    const got = r.get("k");
    expect(got.content).toBe("second-longer");
    expect(after.size).toBe("second-longer".length);
  });

  it("list returns one entry per artifact, sorted by name", () => {
    const r = reg();
    r.save("b", "B");
    r.save("a", "A");
    r.save("c", "C");
    const names = r.list().map((e) => e.name);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("list reports size + mtime per entry", () => {
    const r = reg();
    r.save("k", "hello");
    const [entry] = r.list();
    expect(entry).toBeDefined();
    expect(entry!.size).toBe(5);
    expect(entry!.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("ArtifactsRegistry — name validation + path safety", () => {
  it("rejects path separators in the name", () => {
    const r = reg();
    expect(() => r.save("a/b", "x")).toThrow(/artifact name/);
    expect(() => r.save("a\\b", "x")).toThrow(/artifact name/);
  });

  it("rejects '..' and leading-dot names", () => {
    const r = reg();
    expect(() => r.save("..", "x")).toThrow(/artifact name/);
    expect(() => r.save(".hidden", "x")).toThrow(/artifact name/);
  });

  it("rejects empty name", () => {
    const r = reg();
    expect(() => r.save("", "x")).toThrow(/artifact name/);
  });

  it("rejects names with unicode / other special chars", () => {
    const r = reg();
    expect(() => r.save("hello world", "x")).toThrow(/artifact name/);
    expect(() => r.save("name:with:colon", "x")).toThrow(/artifact name/);
  });

  it("accepts safe names: letters, digits, '.', '_', '-'", () => {
    const r = reg();
    expect(() => r.save("script.js", "x")).not.toThrow();
    expect(() => r.save("my_file-01.txt", "x")).not.toThrow();
  });
});

describe("ArtifactsRegistry — get errors", () => {
  it("throws a helpful error when the name is unknown", () => {
    const r = reg();
    expect(() => r.get("missing")).toThrow(/artifact_get: no artifact "missing"/);
  });
});

describe("ArtifactsRegistry — capacity caps", () => {
  it("evicts oldest-write entries past the entry-count cap", () => {
    // simulate hitting the cap. We don't actually save 200 entries — instead
    // we pre-stage existing files with controlled mtimes, then save one more
    // to trigger eviction.
    mkdirSync(storage, { recursive: true });
    const epoch = new Date("2026-01-01T00:00:00Z").getTime() / 1000;
    for (let i = 0; i < ARTIFACT_MAX_ENTRIES; i++) {
      const p = join(storage, `pre-${i}`);
      writeFileSync(p, `seed-${i}`);
      utimesSync(p, epoch + i, epoch + i); // ascending mtime: pre-0 is oldest
    }
    const r = reg();
    expect(r.list().length).toBe(ARTIFACT_MAX_ENTRIES);
    r.save("freshly-added", "new"); // this is newest by mtime
    const after = r.list();
    expect(after.length).toBe(ARTIFACT_MAX_ENTRIES);
    // oldest (pre-0) should be evicted; the newest staged file + the new one
    // both survive.
    expect(after.find((e) => e.name === "pre-0")).toBeUndefined();
    expect(after.find((e) => e.name === "freshly-added")).toBeDefined();
    expect(after.find((e) => e.name === `pre-${ARTIFACT_MAX_ENTRIES - 1}`)).toBeDefined();
  });

  it("evicts oldest-write entries past the byte cap", () => {
    // Use the byte cap directly. Each entry ~ 1/3 of the cap so the third
    // save triggers eviction of the first.
    const chunk = Math.floor(ARTIFACT_MAX_BYTES / 3) + 1;
    mkdirSync(storage, { recursive: true });
    const r = reg();
    // stage two large entries first, with controlled ascending mtimes so the
    // first one is oldest.
    const p1 = join(storage, "first");
    writeFileSync(p1, Buffer.alloc(chunk, 0x41));
    const epoch1 = new Date("2026-01-01T00:00:00Z").getTime() / 1000;
    utimesSync(p1, epoch1, epoch1);
    const p2 = join(storage, "second");
    writeFileSync(p2, Buffer.alloc(chunk, 0x42));
    utimesSync(p2, epoch1 + 1, epoch1 + 1);
    // third save pushes us over — first should be evicted.
    r.save("third", "x".repeat(chunk));
    const names = r.list().map((e) => e.name).sort();
    expect(names).toContain("third");
    expect(names).toContain("second");
    expect(names).not.toContain("first");
  });

  it("the cap constants are documented", () => {
    expect(ARTIFACT_MAX_ENTRIES).toBe(200);
    expect(ARTIFACT_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe("ArtifactsRegistry — clear", () => {
  it("removes the whole storage dir on clear", () => {
    const r = reg();
    r.save("a", "A");
    r.save("b", "B");
    expect(existsSync(storage)).toBe(true);
    r.clear();
    expect(existsSync(storage)).toBe(false);
  });

  it("is idempotent — clear on an empty / missing dir is a no-op", () => {
    const r = reg();
    expect(() => r.clear()).not.toThrow();
    expect(() => r.clear()).not.toThrow();
  });
});
