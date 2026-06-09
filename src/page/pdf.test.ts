import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPdfSupported, defaultPdfPath, pdfSave } from "./pdf.js";

/** Minimal Playwright `page` stand-in. We mock `page.pdf` so the test never
 *  spawns a browser — the surface area we own is "did we route the args
 *  correctly and write to a workspace-rooted file"; the Chromium codepath
 *  itself is Playwright's concern. */
interface FakePdfArgs {
  path?: string;
  format?: string;
  scale?: number;
  printBackground?: boolean;
}
function fakePage(opts: { writeBytes?: number } = {}) {
  const pdf = vi.fn(async (o: FakePdfArgs) => {
    // Simulate Playwright writing the file synchronously.
    if (o.path) writeFileSync(o.path, Buffer.alloc(opts.writeBytes ?? 1234));
  });
  return { page: { pdf } as never, pdf };
}

let WS: string;
beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), "browx-pdf-"));
});
afterEach(() => {
  rmSync(WS, { recursive: true, force: true });
});

describe("assertPdfSupported", () => {
  it("permits managed `persistent` sessions", () => {
    expect(assertPdfSupported({ mode: "persistent" })).toBeNull();
  });
  it("permits managed `incognito` sessions", () => {
    expect(assertPdfSupported({ mode: "incognito" })).toBeNull();
  });
  it("refuses `attached` (BYOB) sessions with a structured error + hint", () => {
    const r = assertPdfSupported({ mode: "attached" });
    expect(r).not.toBeNull();
    expect(r!.error).toMatch(/attached|BYOB/);
    expect(r!.hint).toMatch(/managed|persistent|incognito/);
  });
});

describe("defaultPdfPath", () => {
  it("is workspace-relative, under `pdfs/`, and namespaced by sessionId", () => {
    const p = defaultPdfPath("alpha");
    expect(p.startsWith("pdfs/alpha-")).toBe(true);
    expect(p.endsWith(".pdf")).toBe(true);
  });
  it("sanitises hostile sessionIds for filesystem use", () => {
    const p = defaultPdfPath("../bad/id");
    // No path separators leak through; the leading segment is still `pdfs/`.
    expect(p.startsWith("pdfs/")).toBe(true);
    expect(p.slice("pdfs/".length)).not.toMatch(/[/\\]/);
  });
});

describe("pdfSave", () => {
  it("dispatches page.pdf with the requested format/scale/printBackground", async () => {
    const { page, pdf } = fakePage({ writeBytes: 2048 });
    const r = await pdfSave(page, WS, "s1", {
      path: "out.pdf",
      format: "Letter",
      scale: 0.75,
      printBackground: true,
    });
    expect(r.ok).toBe(true);
    expect(r.format).toBe("Letter");
    expect(r.scale).toBe(0.75);
    expect(r.printBackground).toBe(true);
    expect(r.bytes).toBe(2048);
    expect(r.path).toBe(join(WS, "out.pdf"));
    expect(pdf).toHaveBeenCalledOnce();
    const arg = pdf.mock.calls[0]![0]!;
    expect(arg.format).toBe("Letter");
    expect(arg.scale).toBe(0.75);
    expect(arg.printBackground).toBe(true);
    expect(arg.path).toBe(join(WS, "out.pdf"));
  });

  it("uses sensible defaults (A4, scale 1, printBackground false)", async () => {
    const { page, pdf } = fakePage();
    const r = await pdfSave(page, WS, "s1", { path: "default.pdf" });
    expect(r.format).toBe("A4");
    expect(r.scale).toBe(1);
    expect(r.printBackground).toBe(false);
    const arg = pdf.mock.calls[0]![0]!;
    expect(arg.format).toBe("A4");
    expect(arg.scale).toBe(1);
    expect(arg.printBackground).toBe(false);
  });

  it("falls back to a default workspace-rooted path when none is supplied", async () => {
    const { page } = fakePage();
    const r = await pdfSave(page, WS, "alpha", {});
    expect(r.path.startsWith(join(WS, "pdfs", "alpha-"))).toBe(true);
    expect(r.path.endsWith(".pdf")).toBe(true);
    expect(existsSync(r.path)).toBe(true);
  });

  it("creates the parent directory if missing", async () => {
    const { page } = fakePage();
    const r = await pdfSave(page, WS, "s1", { path: "nested/deeply/out.pdf" });
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toBe(join(WS, "nested/deeply/out.pdf"));
  });

  it("rejects a path that escapes the workspace", async () => {
    const { page } = fakePage();
    await expect(pdfSave(page, WS, "s1", { path: "../../etc/escape.pdf" })).rejects.toThrow(
      /\$BROWX_WORKSPACE/,
    );
  });

  it("rejects an absolute path outside the workspace", async () => {
    const { page } = fakePage();
    await expect(pdfSave(page, WS, "s1", { path: "/tmp/elsewhere.pdf" })).rejects.toThrow(
      /\$BROWX_WORKSPACE/,
    );
  });

  it("rejects scale below the [0.1, 2.0] band", async () => {
    const { page } = fakePage();
    await expect(pdfSave(page, WS, "s1", { path: "x.pdf", scale: 0.05 })).rejects.toThrow(
      /scale must be in \[0\.1, 2\.0\]/,
    );
  });

  it("rejects scale above the [0.1, 2.0] band", async () => {
    const { page } = fakePage();
    await expect(pdfSave(page, WS, "s1", { path: "x.pdf", scale: 5 })).rejects.toThrow(
      /scale must be in \[0\.1, 2\.0\]/,
    );
  });
});
