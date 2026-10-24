import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DownloadsRegistry,
  attachDownloadCapture,
  mimeTypeFromName,
  readCapturedBytes,
  sanitiseFilename,
} from "./downloads.js";

describe("sanitiseFilename", () => {
  it.each([
    { name: "strips forward slashes", input: "a/b/c.pdf", want: "a_b_c.pdf" },
    { name: "strips back slashes", input: "a\\b\\c.pdf", want: "a_b_c.pdf" },
    { name: "strips one leading dot so the file isn't hidden", input: ".bashrc", want: "bashrc" },
    { name: 'a lone slash falls back to "download"', input: "/", want: "download" },
    { name: 'all dots fall back to "download"', input: "...", want: "download" },
  ])("sanitiseFilename: $name", ({ input, want }) => {
    expect(sanitiseFilename(input)).toBe(want);
  });

  it("caps very long names", () => {
    const big = "a".repeat(500) + ".pdf";
    const out = sanitiseFilename(big);
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("mimeTypeFromName", () => {
  it.each([
    { name: "infers csv case-insensitively", file: "a.CSV", want: "text/csv" },
    { name: "returns undefined for an extension-less name", file: "README", want: undefined },
    { name: "returns undefined for an unknown extension", file: "a.bogus", want: undefined },
  ])("mimeTypeFromName: $name", ({ file, want }) => {
    expect(mimeTypeFromName(file)).toBe(want);
  });
});

describe("DownloadsRegistry", () => {
  it("records entries with monotonic ids and tracks since(ts)", () => {
    const reg = new DownloadsRegistry("/tmp/x");
    const a = reg.record({
      suggestedFilename: "a.pdf",
      sizeBytes: 1,
      path: "/tmp/x/a",
      capturedAt: 100,
    });
    const b = reg.record({
      suggestedFilename: "b.csv",
      sizeBytes: 2,
      path: "/tmp/x/b",
      capturedAt: 200,
    });
    expect(a.id).toBe("d1");
    expect(b.id).toBe("d2");
    expect(reg.get("d1")?.suggestedFilename).toBe("a.pdf");
    expect(reg.since(150).map((d) => d.id)).toEqual(["d2"]);
    expect(reg.since(50).map((d) => d.id)).toEqual(["d1", "d2"]);
  });
});

describe("DownloadsRegistry pending captures", () => {
  const record = (reg: DownloadsRegistry, name: string, capturedAt: number) =>
    reg.record({ suggestedFilename: name, sizeBytes: 1, path: `/tmp/x/${name}`, capturedAt });

  it.each([
    {
      name: "drops a pending capture once an action window slices it",
      advance: (reg: DownloadsRegistry) => reg.since(5_000),
    },
    {
      name: "drops a pending capture nobody claimed after the timeout",
      advance: () => vi.setSystemTime(10_000 + DownloadsRegistry.PENDING_TTL_MS + 1),
    },
  ])("DownloadsRegistry pending: $name", ({ advance }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const reg = new DownloadsRegistry("/tmp/x");
      record(reg, "a", 10_000);
      expect(reg.pendingCount()).toBe(1);
      advance(reg);
      expect(reg.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readCapturedBytes", () => {
  it("returns base64 + size for a captured file", () => {
    const dir = mkdtempSync(join(tmpdir(), "brx-dl-"));
    try {
      const reg = new DownloadsRegistry(dir);
      const p = join(dir, "x.txt");
      writeFileSync(p, "hello");
      reg.record({
        suggestedFilename: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        path: p,
        capturedAt: Date.now(),
      });
      const r = readCapturedBytes(reg, "d1");
      expect(r.bytes).toBe(5);
      expect(Buffer.from(r.base64 ?? "", "base64").toString()).toBe("hello");
      expect(r.path).toBe(p);
      expect(r.mimeType).toBe("text/plain");
      expect(r.suggestedFilename).toBe("x.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file over the byte cap, naming the cap and the saved path", () => {
    const dir = mkdtempSync(join(tmpdir(), "brx-dl-"));
    try {
      const reg = new DownloadsRegistry(dir);
      const p = join(dir, "big.bin");
      writeFileSync(p, "0123456789");
      reg.record({ suggestedFilename: "big.bin", sizeBytes: 10, path: p, capturedAt: Date.now() });
      let message = "";
      try {
        readCapturedBytes(reg, "d1", { maxBytes: 4 });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("4-byte limit");
      expect(message).toContain(p);
      // A file at the cap still reads.
      expect(readCapturedBytes(reg, "d1", { maxBytes: 10 }).bytes).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pathOnly returns size and path without reading the file or applying the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "brx-dl-"));
    try {
      const reg = new DownloadsRegistry(dir);
      const p = join(dir, "big.bin");
      writeFileSync(p, "0123456789");
      reg.record({ suggestedFilename: "big.bin", sizeBytes: 10, path: p, capturedAt: Date.now() });
      const r = readCapturedBytes(reg, "d1", { pathOnly: true, maxBytes: 4 });
      expect(r.base64).toBeUndefined();
      expect(r.bytes).toBe(10);
      expect(r.path).toBe(p);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on unknown id with a hint to call downloads_capture first", () => {
    const reg = new DownloadsRegistry("/tmp/x");
    expect(() => readCapturedBytes(reg, "d999")).toThrow(/unknown id .* downloads_capture/);
  });

  it("throws when the file vanished from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "brx-dl-"));
    try {
      const reg = new DownloadsRegistry(dir);
      const p = join(dir, "gone.txt");
      reg.record({ suggestedFilename: "gone.txt", sizeBytes: 0, path: p, capturedAt: Date.now() });
      expect(() => readCapturedBytes(reg, "d1")).toThrow(/file vanished/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("attachDownloadCapture", () => {
  type DownloadListener = (download: unknown) => void;
  function fakeContextAndDownload(suggestedFilename: string) {
    let listener: DownloadListener | undefined;
    const context = {
      on: (event: string, cb: DownloadListener) => {
        if (event === "download") listener = cb;
      },
    };
    const saveCalls: string[] = [];
    let cancelled = 0;
    const download = {
      suggestedFilename: () => suggestedFilename,
      saveAs: vi.fn(async (path: string) => {
        saveCalls.push(path);
        writeFileSync(path, "DATA");
      }),
      cancel: vi.fn(async () => {
        cancelled++;
      }),
    };
    return { context, download, listener: () => listener, saveCalls, cancelled: () => cancelled };
  }

  it("discards the download when captureOn=false (cancels, records nothing)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brx-dl-"));
    try {
      const reg = new DownloadsRegistry(dir);
      const f = fakeContextAndDownload("note.pdf");

      attachDownloadCapture(f.context as any, reg);
      const cb = f.listener();
      expect(cb).toBeDefined();
      cb!(f.download);
      // listener is sync-fire-and-forget — yield for the inner async path.
      await new Promise((r) => setTimeout(r, 10));
      expect(reg.list()).toEqual([]);
      expect(f.cancelled()).toBe(1);
      expect(f.saveCalls.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists + records when captureOn=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brx-dl-"));
    try {
      const reg = new DownloadsRegistry(dir);
      reg.captureOn = true;
      const f = fakeContextAndDownload("report.pdf");

      attachDownloadCapture(f.context as any, reg);
      f.listener()!(f.download);
      await new Promise((r) => setTimeout(r, 10));
      const all = reg.list();
      expect(all.length).toBe(1);
      expect(all[0]!.suggestedFilename).toBe("report.pdf");
      expect(all[0]!.mimeType).toBe("application/pdf");
      expect(all[0]!.sizeBytes).toBe(4);
      expect(all[0]!.path.startsWith(dir)).toBe(true);
      expect(existsSync(all[0]!.path)).toBe(true);
      expect(readFileSync(all[0]!.path, "utf8")).toBe("DATA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitises a traversal-shaped suggested filename before writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brx-dl-"));
    try {
      const reg = new DownloadsRegistry(dir);
      reg.captureOn = true;
      const f = fakeContextAndDownload("../../../etc/passwd");

      attachDownloadCapture(f.context as any, reg);
      f.listener()!(f.download);
      await new Promise((r) => setTimeout(r, 10));
      const [entry] = reg.list();
      expect(entry).toBeDefined();
      // on-disk path is inside the storage dir.
      expect(entry!.path.startsWith(dir)).toBe(true);
      // on-disk filename has no separators (path-traversal is impossible
      // once separators are gone — the literal substring ".." can survive in
      // the safe-name but it cannot navigate the filesystem without `/`).
      const base = entry!.path.slice(dir.length + 1);
      expect(base).not.toContain("/");
      expect(base).not.toContain("\\");
      // raw filename is preserved alongside the sanitised one.
      expect(entry!.rawSuggestedFilename).toBe("../../../etc/passwd");
      // sanitised name doesn't START with a dot (no hidden-file write).
      expect(entry!.suggestedFilename.startsWith(".")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
