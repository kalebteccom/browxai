import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { domExport, defaultDomExportPath, type DomExportPage, type DomExportArgs } from "./dom-export.js";

interface PageWalkResult {
  html?: string;
  nodes?: Array<Record<string, unknown>>;
  nodeCount: number;
  shadowRootCount: number;
  hasCustomElements: boolean;
}

function fakePage(result: PageWalkResult, capture?: { args?: unknown }): DomExportPage {
  return {
    async evaluate<T>(_fn: string, a?: unknown): Promise<T> {
      if (capture) capture.args = a;
      return result as unknown as T;
    },
  };
}

let WS: string;
beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), "browx-domexp-"));
});
afterEach(() => {
  rmSync(WS, { recursive: true, force: true });
});

describe("defaultDomExportPath", () => {
  it("is workspace-relative, under dom-dumps/, ext matches format", () => {
    expect(defaultDomExportPath("alpha", "html").startsWith("dom-dumps/alpha-")).toBe(true);
    expect(defaultDomExportPath("alpha", "html").endsWith(".html")).toBe(true);
    expect(defaultDomExportPath("alpha", "jsonl").endsWith(".jsonl")).toBe(true);
  });

  it("sanitises hostile sessionIds", () => {
    const p = defaultDomExportPath("../bad/id", "html");
    expect(p.startsWith("dom-dumps/")).toBe(true);
    expect(p.slice("dom-dumps/".length)).not.toMatch(/[\\/]/);
  });
});

describe("domExport — html mode", () => {
  it("writes documentElement.outerHTML to a workspace-rooted file", async () => {
    const page = fakePage({
      html: "<html><body>hello</body></html>",
      nodeCount: 3,
      shadowRootCount: 0,
      hasCustomElements: false,
    });
    const r = await domExport(page, WS, "s1", { path: "dump.html", format: "html" });
    expect(r.ok).toBe(true);
    expect(r.format).toBe("html");
    expect(r.path).toBe(join(WS, "dump.html"));
    expect(r.nodeCount).toBe(3);
    expect(r.shadowRootCount).toBe(0);
    expect(readFileSync(r.path, "utf8")).toContain("hello");
    expect(r.warnings.some((w) => w.toLowerCase().includes("unmasked"))).toBe(true);
  });

  it("surfaces the outerHTML-loses-shadow-DOM gap when shadow content is requested", async () => {
    const page = fakePage({
      html: "<html><body><my-widget></my-widget></body></html>",
      nodeCount: 4,
      shadowRootCount: 0,
      hasCustomElements: true,
    });
    const r = await domExport(page, WS, "s1", { path: "shadowed.html", format: "html", includeShadow: true });
    expect(r.warnings.some((w) => w.toLowerCase().includes("shadow-dom"))).toBe(true);
    expect(r.warnings.some((w) => w.toLowerCase().includes("closed shadow roots"))).toBe(true);
  });

  it("defaults to a workspace-rooted path under dom-dumps/", async () => {
    const page = fakePage({ html: "<html/>", nodeCount: 1, shadowRootCount: 0, hasCustomElements: false });
    const r = await domExport(page, WS, "alpha", {});
    expect(r.path.startsWith(join(WS, "dom-dumps", "alpha-"))).toBe(true);
    expect(existsSync(r.path)).toBe(true);
    expect(r.path.endsWith(".html")).toBe(true);
  });
});

describe("domExport — jsonl mode", () => {
  it("writes one JSON object per line with tag/attrs/depth", async () => {
    const page = fakePage({
      nodes: [
        { tag: "html", attrs: {}, depth: 0 },
        { tag: "body", attrs: {}, depth: 1 },
        { tag: "button", attrs: { id: "go" }, depth: 2, role: "button", text: "Go" },
      ],
      nodeCount: 3,
      shadowRootCount: 0,
      hasCustomElements: false,
    });
    const r = await domExport(page, WS, "s1", { path: "tree.jsonl", format: "jsonl" });
    expect(r.format).toBe("jsonl");
    expect(r.nodeCount).toBe(3);

    const body = readFileSync(r.path, "utf8");
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].tag).toBe("html");
    expect(parsed[2].role).toBe("button");
    expect(parsed[2].text).toBe("Go");
    expect(parsed[2].attrs.id).toBe("go");
  });

  it("descends shadow roots and reports the count", async () => {
    const page = fakePage({
      nodes: [
        { tag: "html", attrs: {}, depth: 0 },
        { tag: "my-card", attrs: {}, depth: 1 },
        { tag: "div", attrs: { class: "shadow-child" }, depth: 2 },
      ],
      nodeCount: 3,
      shadowRootCount: 1,
      hasCustomElements: true,
    });
    const r = await domExport(page, WS, "s1", { path: "shadow.jsonl", format: "jsonl", includeShadow: true });
    expect(r.shadowRootCount).toBe(1);
    expect(r.warnings.some((w) => w.toLowerCase().includes("closed shadow roots"))).toBe(true);
  });

  it("threads includeShadow through to the page-side walker arg", async () => {
    const captured: { args?: unknown } = {};
    const page = fakePage(
      { nodes: [], nodeCount: 0, shadowRootCount: 0, hasCustomElements: false },
      captured,
    );
    await domExport(page, WS, "s1", { path: "skip.jsonl", format: "jsonl", includeShadow: false });
    expect((captured.args as { includeShadow: boolean }).includeShadow).toBe(false);
  });

  it("defaults includeShadow:true", async () => {
    const captured: { args?: unknown } = {};
    const page = fakePage(
      { nodes: [], nodeCount: 0, shadowRootCount: 0, hasCustomElements: false },
      captured,
    );
    await domExport(page, WS, "s1", { path: "def.jsonl", format: "jsonl" });
    expect((captured.args as { includeShadow: boolean }).includeShadow).toBe(true);
  });

  it("writes an empty file when the page is empty", async () => {
    const page = fakePage({ nodes: [], nodeCount: 0, shadowRootCount: 0, hasCustomElements: false });
    const r = await domExport(page, WS, "s1", { path: "empty.jsonl", format: "jsonl" });
    expect(r.nodeCount).toBe(0);
    expect(statSync(r.path).size).toBe(0);
  });
});

describe("domExport — workspace escape rejection", () => {
  it("rejects a path that escapes the workspace", async () => {
    const page = fakePage({ html: "", nodeCount: 0, shadowRootCount: 0, hasCustomElements: false });
    await expect(
      domExport(page, WS, "s1", { path: "../escape.html" }),
    ).rejects.toThrow(/\$BROWX_WORKSPACE/);
  });

  it("rejects an absolute path outside the workspace", async () => {
    const page = fakePage({ html: "", nodeCount: 0, shadowRootCount: 0, hasCustomElements: false });
    await expect(
      domExport(page, WS, "s1", { path: "/tmp/leak.html" }),
    ).rejects.toThrow(/\$BROWX_WORKSPACE/);
  });
});

describe("domExport — secrets-masking caveat", () => {
  it("warnings[] always includes the unmasked caveat", async () => {
    const page = fakePage({ html: "<html/>", nodeCount: 1, shadowRootCount: 0, hasCustomElements: false });
    const args: DomExportArgs = { path: "warn.html", format: "html" };
    const r = await domExport(page, WS, "s1", args);
    expect(r.warnings[0]?.toLowerCase().includes("unmasked")).toBe(true);
  });
});
