import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pageArchive,
  defaultArchivePath,
  type ArchivePage,
  type ArchiveArgs,
} from "./archive.js";

/** In-memory page stand-in. The discovery script returns whatever HTML +
 *  resources are programmed; per-URL fetch results are mapped by URL. The
 *  stub never spawns a browser — the surface area we own is routing,
 *  budgeting, dropping + writing; the real fetch path is a Playwright/Chromium
 *  concern. */
function fakePage(opts: {
  html: string;
  resources: Array<{ url: string; kind: string; rawRef: string }>;
  responses: Record<
    string,
    { ok: boolean; base64?: string; contentType?: string; bytes?: number; error?: string }
  >;
}): ArchivePage {
  return {
    async evaluate(expr: string): Promise<unknown> {
      // Discovery script begins with `(() =>` and references documentElement.
      // Fetch script begins with `(async () =>` and contains JSON-quoted URL.
      if (expr.includes("document.documentElement")) {
        return {
          html: opts.html,
          baseUri: "https://example.test/",
          resources: opts.resources,
        };
      }
      // Match fetched URL by scanning for the JSON-stringified literal.
      for (const url of Object.keys(opts.responses)) {
        if (expr.includes(JSON.stringify(url))) {
          return opts.responses[url]!;
        }
      }
      return { ok: false, error: "no mock response" };
    },
  };
}

const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=";

let WS: string;
beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), "browx-archive-"));
});
afterEach(() => {
  rmSync(WS, { recursive: true, force: true });
});

describe("defaultArchivePath", () => {
  it("is workspace-relative, under archives/, namespaced by sessionId", () => {
    const dir = defaultArchivePath("alpha", "directory");
    expect(dir.startsWith("archives/alpha-")).toBe(true);
    expect(dir.endsWith(".html")).toBe(false);
    const file = defaultArchivePath("alpha", "single-file");
    expect(file.startsWith("archives/alpha-")).toBe(true);
    expect(file.endsWith(".html")).toBe(true);
  });
  it("sanitises hostile sessionIds for filesystem use", () => {
    const p = defaultArchivePath("../bad/id", "directory");
    expect(p.startsWith("archives/")).toBe(true);
    expect(p.slice("archives/".length)).not.toMatch(/[\/\\]/);
  });
});

describe("pageArchive — directory mode", () => {
  it("writes index.html + assets/ sidecar and rewrites refs", async () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="https://example.test/site.css"></head><body><img src="https://example.test/hero.png"></body></html>`;
    const page = fakePage({
      html,
      resources: [
        { url: "https://example.test/site.css", kind: "stylesheet", rawRef: "https://example.test/site.css" },
        { url: "https://example.test/hero.png", kind: "image", rawRef: "https://example.test/hero.png" },
      ],
      responses: {
        "https://example.test/site.css": { ok: true, base64: Buffer.from("body{}").toString("base64"), contentType: "text/css", bytes: 6 },
        "https://example.test/hero.png": { ok: true, base64: TINY_PNG_B64, contentType: "image/png", bytes: Buffer.from(TINY_PNG_B64, "base64").length },
      },
    });

    const r = await pageArchive(page, WS, "s1", { path: "archive-1", format: "directory" });
    expect(r.ok).toBe(true);
    expect(r.format).toBe("directory");
    expect(r.resourceCount).toBe(2);
    expect(r.droppedCount).toBe(0);
    expect(r.path).toBe(join(WS, "archive-1"));

    const indexPath = join(r.path, "index.html");
    expect(existsSync(indexPath)).toBe(true);
    const written = readFileSync(indexPath, "utf8");
    // Original absolute refs are rewritten to relative sidecar paths.
    expect(written).not.toContain("https://example.test/site.css");
    expect(written).not.toContain("https://example.test/hero.png");
    expect(written).toContain("assets/styles/");
    expect(written).toContain("assets/images/");

    // sidecar files actually exist.
    const stylesDir = join(r.path, "assets", "styles");
    const imagesDir = join(r.path, "assets", "images");
    expect(readdirSync(stylesDir).length).toBe(1);
    expect(readdirSync(imagesDir).length).toBe(1);

    // warnings always carry the secrets-masking caveat.
    expect(r.warnings.some((w) => w.toLowerCase().includes("unmasked"))).toBe(true);
  });

  it("falls back to a default workspace-rooted path", async () => {
    const page = fakePage({ html: "<html></html>", resources: [], responses: {} });
    const r = await pageArchive(page, WS, "alpha", {});
    expect(r.path.startsWith(join(WS, "archives", "alpha-"))).toBe(true);
    expect(existsSync(join(r.path, "index.html"))).toBe(true);
  });
});

describe("pageArchive — single-file mode", () => {
  it("inlines resources as data: URIs in one HTML file", async () => {
    const html = `<!doctype html><html><body><img src="https://example.test/hero.png"></body></html>`;
    const page = fakePage({
      html,
      resources: [
        { url: "https://example.test/hero.png", kind: "image", rawRef: "https://example.test/hero.png" },
      ],
      responses: {
        "https://example.test/hero.png": { ok: true, base64: TINY_PNG_B64, contentType: "image/png", bytes: Buffer.from(TINY_PNG_B64, "base64").length },
      },
    });

    const r = await pageArchive(page, WS, "s1", { path: "archive.html", format: "single-file" });
    expect(r.ok).toBe(true);
    expect(r.format).toBe("single-file");
    expect(r.resourceCount).toBe(1);
    expect(r.path).toBe(join(WS, "archive.html"));

    const written = readFileSync(r.path, "utf8");
    expect(written).toContain("data:image/png;base64,");
    expect(written).not.toContain("https://example.test/hero.png");
  });
});

describe("pageArchive — workspace escape rejection", () => {
  it("rejects a `path` that escapes the workspace", async () => {
    const page = fakePage({ html: "", resources: [], responses: {} });
    await expect(
      pageArchive(page, WS, "s1", { path: "../escape" }),
    ).rejects.toThrow(/\$BROWX_WORKSPACE/);
  });
  it("rejects an absolute path outside the workspace", async () => {
    const page = fakePage({ html: "", resources: [], responses: {} });
    await expect(
      pageArchive(page, WS, "s1", { path: "/tmp/escape.html", format: "single-file" }),
    ).rejects.toThrow(/\$BROWX_WORKSPACE/);
  });
});

describe("pageArchive — maxSize enforcement", () => {
  it("drops resources past the byte budget and reports the cap warning", async () => {
    // Tiny cap → first resource fits, second is dropped.
    const big = "A".repeat(1024); // ~1KB raw
    const b64 = Buffer.from(big).toString("base64");
    const page = fakePage({
      html: `<html><body><img src="https://a.test/1.png"><img src="https://a.test/2.png"></body></html>`,
      resources: [
        { url: "https://a.test/1.png", kind: "image", rawRef: "https://a.test/1.png" },
        { url: "https://a.test/2.png", kind: "image", rawRef: "https://a.test/2.png" },
      ],
      responses: {
        "https://a.test/1.png": { ok: true, base64: b64, contentType: "image/png", bytes: 1024 },
        "https://a.test/2.png": { ok: true, base64: b64, contentType: "image/png", bytes: 1024 },
      },
    });

    // 1.5 KB cap, in MB: 0.0015
    const r = await pageArchive(page, WS, "s1", { path: "small", format: "directory", maxSizeMb: 0.0015 });
    expect(r.resourceCount).toBe(1);
    expect(r.droppedCount).toBe(1);
    expect(r.warnings.some((w) => w.includes("maxSizeMb"))).toBe(true);
  });

  it("rejects a non-positive or absurd maxSizeMb up-front", async () => {
    const page = fakePage({ html: "", resources: [], responses: {} });
    await expect(
      pageArchive(page, WS, "s1", { path: "x", maxSizeMb: 0 }),
    ).rejects.toThrow(/maxSizeMb/);
    await expect(
      pageArchive(page, WS, "s1", { path: "x", maxSizeMb: 100_000 }),
    ).rejects.toThrow(/maxSizeMb/);
  });
});

describe("pageArchive — fetch-failure tolerance", () => {
  it("tolerates fetch failures and counts them under droppedCount", async () => {
    const page = fakePage({
      html: `<html><body><img src="https://ok.test/a.png"><img src="https://blocked.test/b.png"></body></html>`,
      resources: [
        { url: "https://ok.test/a.png", kind: "image", rawRef: "https://ok.test/a.png" },
        { url: "https://blocked.test/b.png", kind: "image", rawRef: "https://blocked.test/b.png" },
      ],
      responses: {
        "https://ok.test/a.png": { ok: true, base64: TINY_PNG_B64, contentType: "image/png", bytes: 70 },
        "https://blocked.test/b.png": { ok: false, error: "Refused to connect because it violates the document's Content Security Policy connect-src directive" },
      },
    });
    const r = await pageArchive(page, WS, "s1", { path: "mixed", format: "directory" });
    expect(r.resourceCount).toBe(1);
    expect(r.droppedCount).toBe(1);
    expect(r.warnings.some((w) => w.toLowerCase().includes("content-security-policy"))).toBe(true);
  });

  it("handles a page-side exception during fetch as a drop, not a crash", async () => {
    const page: ArchivePage = {
      async evaluate(expr: string): Promise<unknown> {
        if (expr.includes("document.documentElement")) {
          return {
            html: `<html><body><img src="https://x.test/a.png"></body></html>`,
            baseUri: "https://x.test/",
            resources: [{ url: "https://x.test/a.png", kind: "image", rawRef: "https://x.test/a.png" }],
          };
        }
        throw new Error("simulated page crash mid-fetch");
      },
    };
    const r = await pageArchive(page, WS, "s1", { path: "crash", format: "directory" });
    expect(r.resourceCount).toBe(0);
    expect(r.droppedCount).toBe(1);
  });
});

describe("pageArchive — empty page", () => {
  it("writes an archive with zero resources without error", async () => {
    const page = fakePage({
      html: `<!doctype html><html><body>hello</body></html>`,
      resources: [],
      responses: {},
    });
    const r = await pageArchive(page, WS, "s1", { path: "empty", format: "directory" });
    expect(r.resourceCount).toBe(0);
    expect(r.droppedCount).toBe(0);
    const idx = readFileSync(join(r.path, "index.html"), "utf8");
    expect(idx).toContain("hello");
    expect(statSync(r.path).isDirectory()).toBe(true);
  });
});

describe("pageArchive — always emits the secrets-masking caveat", () => {
  it("warnings[] always includes the unmasked-archive caveat", async () => {
    const page = fakePage({ html: "<html></html>", resources: [], responses: {} });
    const args: ArchiveArgs = { path: "warn", format: "directory" };
    const r = await pageArchive(page, WS, "s1", args);
    const has = r.warnings.some(
      (w) => w.includes("UNMASKED") || w.toLowerCase().includes("unmasked"),
    );
    expect(has).toBe(true);
  });
});
