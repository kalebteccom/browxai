import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright-core";

import {
  type AssetExportArgs,
  assetExport,
  compileUrlPattern,
  filenameFromUrl,
  matchesFilter,
  resolveAssetExportDir,
  resolveCollision,
  sanitiseAssetFilename,
} from "./asset-export.js";
import { NetworkBuffer, type NetworkEntry } from "./network.js";

describe("sanitiseAssetFilename", () => {
  it("strips path separators (forward + back)", () => {
    expect(sanitiseAssetFilename("a/b/c.png")).toBe("a_b_c.png");
    expect(sanitiseAssetFilename("a\\b\\c.png")).toBe("a_b_c.png");
  });
  it("collapses traversal sequences and strips leading dots", () => {
    const out = sanitiseAssetFilename("../../evil.sh");
    expect(out).not.toContain("/");
    expect(out).not.toContain("..");
    expect(out).not.toMatch(/^\./);
  });
  it("caps long names", () => {
    const long = "a".repeat(500) + ".png";
    expect(sanitiseAssetFilename(long).length).toBeLessThanOrEqual(200);
  });
  it('falls back to "asset" on empty / all-stripped input', () => {
    expect(sanitiseAssetFilename("")).toBe("asset");
    expect(sanitiseAssetFilename("/")).toBe("asset");
    expect(sanitiseAssetFilename("...")).toBe("asset");
  });
});

describe("filenameFromUrl", () => {
  it("takes the last path segment", () => {
    expect(filenameFromUrl("https://x.com/static/img/logo.png")).toBe("logo.png");
  });
  it("decodes percent-encoding", () => {
    expect(filenameFromUrl("https://x.com/a/hello%20world.png")).toBe("hello world.png");
  });
  it("falls back to 'asset' on directory roots", () => {
    expect(filenameFromUrl("https://x.com/")).toBe("asset");
  });
});

describe("resolveCollision", () => {
  it("walks until a free slot is found", () => {
    const used = new Set(["a.png", "a-1.png", "a-2.png"]);
    expect(resolveCollision("a.png", used)).toBe("a-3.png");
  });
  it("handles extensionless names", () => {
    const used = new Set(["README"]);
    expect(resolveCollision("README", used)).toBe("README-1");
  });
});

describe("compileUrlPattern", () => {
  it("throws a structured error on invalid regex", () => {
    expect(() => compileUrlPattern("(unbalanced")).toThrow(/asset_export: invalid/);
  });
});

describe("matchesFilter", () => {
  const baseEntry: NetworkEntry = {
    method: "GET",
    url: "https://x.com/img/logo.png",
    type: "Image",
    status: 200,
    mimeType: "image/png",
    bytes: 1024,
  };
  it("defaults status to 2xx", () => {
    expect(matchesFilter(baseEntry, { urlPattern: null, status: null })).toBe(true);
    expect(matchesFilter({ ...baseEntry, status: 404 }, { urlPattern: null, status: null })).toBe(
      false,
    );
    expect(matchesFilter({ ...baseEntry, status: 301 }, { urlPattern: null, status: null })).toBe(
      false,
    );
  });
  it("honours an explicit status allow-list", () => {
    expect(
      matchesFilter({ ...baseEntry, status: 404 }, { urlPattern: null, status: new Set([404]) }),
    ).toBe(true);
  });
  it("rejects entries without status", () => {
    const noStatus: NetworkEntry = { ...baseEntry };
    delete noStatus.status;
    expect(matchesFilter(noStatus, { urlPattern: null, status: null })).toBe(false);
  });
  it("matches mime substrings case-insensitively", () => {
    expect(matchesFilter(baseEntry, { mime: ["IMAGE/"], urlPattern: null, status: null })).toBe(
      true,
    );
    expect(matchesFilter(baseEntry, { mime: ["video/"], urlPattern: null, status: null })).toBe(
      false,
    );
  });
  it("rejects when mime filter set but entry has no mime", () => {
    const noMime: NetworkEntry = { ...baseEntry };
    delete noMime.mimeType;
    expect(matchesFilter(noMime, { mime: ["image/"], urlPattern: null, status: null })).toBe(false);
  });
  it("matches urlPattern (case-insensitive)", () => {
    const p = compileUrlPattern("\\.PNG$")!;
    expect(matchesFilter(baseEntry, { urlPattern: p, status: null })).toBe(true);
  });
  it("enforces minBytes / maxBytes only when bytes known", () => {
    expect(matchesFilter(baseEntry, { urlPattern: null, status: null, minBytes: 2000 })).toBe(
      false,
    );
    expect(matchesFilter(baseEntry, { urlPattern: null, status: null, maxBytes: 500 })).toBe(false);
    expect(
      matchesFilter(baseEntry, { urlPattern: null, status: null, minBytes: 100, maxBytes: 2000 }),
    ).toBe(true);
    const noBytes: NetworkEntry = { ...baseEntry };
    delete noBytes.bytes;
    // unknown bytes admitted at the filter step — the caller still enforces
    // the post-fetch total-byte budget.
    expect(matchesFilter(noBytes, { urlPattern: null, status: null, minBytes: 1_000_000 })).toBe(
      true,
    );
  });
});

describe("resolveAssetExportDir", () => {
  it("defaults to assets/<sessionId>-<ts>/ under workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      const out = resolveAssetExportDir(root, "sess");
      expect(out.startsWith(root)).toBe(true);
      expect(out).toMatch(/assets\/sess-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("honours a workspace-relative `intoDir`", () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      const out = resolveAssetExportDir(root, "sess", "out/icons");
      expect(out).toBe(join(root, "out/icons"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects an escape", () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      expect(() => resolveAssetExportDir(root, "sess", "../escape")).toThrow(/must resolve inside/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------- end-to-end integration with a real NetworkBuffer ----------------

/** Build a NetworkBuffer pre-loaded with caller-supplied entries via direct
 *  ring access. The CDP listener path is exercised by `network.test.ts`; here
 *  we only care that `iter()` exposes what the export consumes. */
function bufferWith(entries: NetworkEntry[]): NetworkBuffer {
  const fakeCdp = { send: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as CDPSession;
  const buf = new NetworkBuffer(fakeCdp);
  // Mutate the private ring through a casted reference — production code
  // never does this; the test does it to skip the CDP event plumbing.
  (buf as unknown as { ring: NetworkEntry[] }).ring = entries.slice();
  return buf;
}

/** Stub CDP — always reports "body discarded" so the in-page-fetch fallback
 *  is exercised end-to-end. */
function stubCdpNoBody(): CDPSession {
  return {
    send: vi.fn(async () => {
      throw new Error("No data found for resource");
    }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as CDPSession;
}

/** Stub Page whose `evaluate` returns the same canned payload for every
 *  URL — we don't actually run a browser in unit tests. */
function stubPageWith(
  per: (
    url: string,
  ) => { ok: true; base64: string; mimeType?: string } | { ok: false; error: string },
): Page {
  return {
    evaluate: vi.fn(async (_fn: unknown, url: string) => per(url)),
  } as unknown as Page;
}

describe("assetExport integration", () => {
  it("filters by mime + urlPattern, persists, writes _manifest.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://x.com/a/logo.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 100,
          requestId: "r1",
        },
        {
          method: "GET",
          url: "https://x.com/a/hero.jpg",
          type: "Image",
          status: 200,
          mimeType: "image/jpeg",
          bytes: 200,
          requestId: "r2",
        },
        {
          method: "GET",
          url: "https://x.com/a/style.css",
          type: "Stylesheet",
          status: 200,
          mimeType: "text/css",
          bytes: 300,
          requestId: "r3",
        },
        {
          method: "GET",
          url: "https://x.com/a/oops.png",
          type: "Image",
          status: 404,
          mimeType: "image/png",
          bytes: 50,
          requestId: "r4",
        },
      ]);
      const cdp = stubCdpNoBody();
      const page = stubPageWith(() => ({
        ok: true,
        base64: Buffer.from("PNGDATA").toString("base64"),
        mimeType: "image/png",
      }));
      const args: AssetExportArgs = { filter: { mime: ["image/"] } };
      const r = await assetExport(
        { cdp, page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        args,
      );
      expect(r.ok).toBe(true);
      // 2 image/* + 2xx — the 404 image and the css are filtered out.
      expect(r.matchedCount).toBe(2);
      expect(r.persistedCount).toBe(2);
      expect(r.droppedCount).toBe(0);
      expect(r.manifest.map((m) => m.savedAs).sort()).toEqual(["hero.jpg", "logo.png"]);
      expect(existsSync(join(r.intoDir, "logo.png"))).toBe(true);
      expect(existsSync(join(r.intoDir, "hero.jpg"))).toBe(true);
      expect(existsSync(join(r.intoDir, "_manifest.json"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(r.intoDir, "_manifest.json"), "utf8"));
      expect(manifest.intoDir).toBe(r.intoDir);
      expect(manifest.manifest).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collision-resolves identical basenames from different paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://x.com/a/logo.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 10,
          requestId: "r1",
        },
        {
          method: "GET",
          url: "https://x.com/b/logo.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 10,
          requestId: "r2",
        },
        {
          method: "GET",
          url: "https://x.com/c/logo.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 10,
          requestId: "r3",
        },
      ]);
      const cdp = stubCdpNoBody();
      const page = stubPageWith(() => ({ ok: true, base64: Buffer.from("x").toString("base64") }));
      const r = await assetExport(
        { cdp, page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        { filter: {} },
      );
      expect(r.persistedCount).toBe(3);
      const names = r.manifest.map((m) => m.savedAs).sort();
      expect(names).toEqual(["logo-1.png", "logo-2.png", "logo.png"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never replaces a file already on disk, and picks the next free name", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      mkdirSync(join(root, "out"));
      writeFileSync(join(root, "out", "logo.png"), "earlier");
      writeFileSync(join(root, "out", "logo-1.png"), "earlier too");
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://x.com/a/logo.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 3,
          requestId: "r1",
        },
      ]);
      const page = stubPageWith(() => ({
        ok: true,
        base64: Buffer.from("new").toString("base64"),
      }));
      const r = await assetExport(
        { cdp: stubCdpNoBody(), page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        { filter: {}, intoDir: "out" },
      );
      expect(r.persistedCount).toBe(1);
      expect(r.manifest[0]!.savedAs).toBe("logo-2.png");
      expect(readFileSync(join(root, "out", "logo.png"), "utf8")).toBe("earlier");
      expect(readFileSync(join(root, "out", "logo-1.png"), "utf8")).toBe("earlier too");
      expect(readFileSync(join(root, "out", "logo-2.png"), "utf8")).toBe("new");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives up on a file name after 1000 taken names and drops the asset", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      mkdirSync(join(root, "out"));
      writeFileSync(join(root, "out", "logo.png"), "taken");
      for (let i = 1; i < 1000; i++) writeFileSync(join(root, "out", `logo-${i}.png`), "taken");
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://x.com/a/logo.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 3,
          requestId: "r1",
        },
      ]);
      const page = stubPageWith(() => ({
        ok: true,
        base64: Buffer.from("new").toString("base64"),
      }));
      const r = await assetExport(
        { cdp: stubCdpNoBody(), page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        { filter: {}, intoDir: "out" },
      );
      expect(r.persistedCount).toBe(0);
      expect(r.droppedCount).toBe(1);
      expect(r.warnings.join("\n")).toMatch(/no free file name.*after 1000 tries/);
      // The 1001st name was never tried.
      expect(existsSync(join(root, "out", "logo-1000.png"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to write chrome.pid at the workspace root", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      writeFileSync(join(root, "chrome.pid"), "4242");
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://x.com/chrome.pid",
          type: "Other",
          status: 200,
          mimeType: "text/plain",
          bytes: 1,
          requestId: "r1",
        },
      ]);
      const page = stubPageWith(() => ({ ok: true, base64: Buffer.from("1").toString("base64") }));
      const r = await assetExport(
        { cdp: stubCdpNoBody(), page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        { filter: {}, intoDir: "." },
      );
      expect(r.persistedCount).toBe(0);
      expect(r.droppedCount).toBe(1);
      expect(r.warnings.join("\n")).toMatch(/chrome\.pid/);
      expect(readFileSync(join(root, "chrome.pid"), "utf8")).toBe("4242");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tolerates in-page fetch failures (CORS / network) without crashing", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://ok.com/a.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 10,
          requestId: "r1",
        },
        {
          method: "GET",
          url: "https://bad.com/b.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 10,
          requestId: "r2",
        },
      ]);
      const cdp = stubCdpNoBody();
      const page = stubPageWith((url) =>
        url.includes("bad.com")
          ? { ok: false as const, error: "CORS rejected" }
          : { ok: true as const, base64: Buffer.from("x").toString("base64") },
      );
      const r = await assetExport(
        { cdp, page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        { filter: {} },
      );
      expect(r.matchedCount).toBe(2);
      expect(r.persistedCount).toBe(1);
      expect(r.droppedCount).toBe(1);
      expect(r.warnings.some((w) => w.includes("bad.com"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects maxCount cap and reports it in warnings", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://x.com/a.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 10,
          requestId: "r1",
        },
        {
          method: "GET",
          url: "https://x.com/b.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 10,
          requestId: "r2",
        },
        {
          method: "GET",
          url: "https://x.com/c.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 10,
          requestId: "r3",
        },
      ]);
      const cdp = stubCdpNoBody();
      const page = stubPageWith(() => ({ ok: true, base64: Buffer.from("x").toString("base64") }));
      const r = await assetExport(
        { cdp, page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        { filter: {}, maxCount: 2 },
      );
      expect(r.matchedCount).toBeGreaterThanOrEqual(2);
      expect(r.persistedCount).toBe(2);
      expect(r.warnings.some((w) => w.includes("maxCount"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("respects maxBytes cap and stops the export early", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://x.com/a.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 5,
          requestId: "r1",
        },
        {
          method: "GET",
          url: "https://x.com/b.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 5,
          requestId: "r2",
        },
        {
          method: "GET",
          url: "https://x.com/c.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 5,
          requestId: "r3",
        },
      ]);
      const cdp = stubCdpNoBody();
      // Each body is 6 bytes. maxBytes=10 → first persisted, second exceeds → stop.
      const page = stubPageWith(() => ({
        ok: true,
        base64: Buffer.from("ABCDEF").toString("base64"),
      }));
      const r = await assetExport(
        { cdp, page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        { filter: {}, maxBytes: 10 },
      );
      expect(r.persistedCount).toBe(1);
      expect(r.warnings.some((w) => w.includes("maxBytes"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers CDP-cached body when available (skips in-page fetch)", async () => {
    const root = mkdtempSync(join(tmpdir(), "browx-asset-"));
    try {
      const buf = bufferWith([
        {
          method: "GET",
          url: "https://x.com/a.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 5,
          requestId: "r1",
        },
      ]);
      const cdp = {
        send: vi.fn(async () => ({
          body: Buffer.from("HELLO").toString("base64"),
          base64Encoded: true,
        })),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as CDPSession;
      const pageEval = vi.fn(async () => ({ ok: false as const, error: "should not run" }));
      const page = { evaluate: pageEval } as unknown as Page;
      const r = await assetExport(
        { cdp, page, buffer: buf, workspaceRoot: root, sessionId: "sess" },
        { filter: {} },
      );
      expect(r.persistedCount).toBe(1);
      expect(pageEval).not.toHaveBeenCalled();
      expect(readFileSync(join(r.intoDir, "a.png"))).toEqual(Buffer.from("HELLO"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
