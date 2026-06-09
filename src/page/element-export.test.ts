/// <reference lib="dom" />
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  elementExport,
  defaultElementExportPath,
  type ElementExportArgs,
  type ElementExportLocator,
  type ElementExportPage,
} from "./element-export.js";

/** In-memory stand-ins for the Playwright Locator + Page surfaces. The
 *  locator's `evaluate` always returns the configured subtree discovery
 *  result; the page's `evaluate` matches fetch requests by URL substring. */
function fakeLocator(opts: {
  count?: number;
  html: string;
  css: string;
  resources: Array<{ url: string; kind: string; rawRef: string }>;
  unreadableStylesheets?: number;
}): ElementExportLocator {
  return {
    async count(): Promise<number> {
      return opts.count ?? 1;
    },
    async evaluate<T>(_fn: (element: Element) => T | Promise<T>): Promise<T> {
      return {
        html: opts.html,
        css: opts.css,
        unreadableStylesheets: opts.unreadableStylesheets ?? 0,
        resources: opts.resources,
      } as unknown as T;
    },
  };
}

function fakePage(
  responses: Record<
    string,
    { ok: boolean; base64?: string; contentType?: string; bytes?: number; error?: string }
  >,
): ElementExportPage {
  return {
    async evaluate(expr: string): Promise<unknown> {
      for (const url of Object.keys(responses)) {
        if (expr.includes(JSON.stringify(url))) {
          return responses[url]!;
        }
      }
      return { ok: false, error: "no mock response" };
    },
  };
}

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=";

let WS: string;
beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), "browx-elexport-"));
});
afterEach(() => {
  rmSync(WS, { recursive: true, force: true });
});

describe("defaultElementExportPath", () => {
  it("is workspace-relative, under elements/, namespaced by sessionId + ref", () => {
    const dir = defaultElementExportPath("alpha", "e7", "directory");
    expect(dir.startsWith("elements/alpha-")).toBe(true);
    expect(dir.endsWith("-e7")).toBe(true);
    expect(dir.endsWith(".html")).toBe(false);
    const file = defaultElementExportPath("alpha", "e7", "single-file");
    expect(file.startsWith("elements/alpha-")).toBe(true);
    expect(file.endsWith(".html")).toBe(true);
  });

  it("sanitises hostile sessionIds + refs", () => {
    const p = defaultElementExportPath("../bad/id", "../e", "directory");
    expect(p.startsWith("elements/")).toBe(true);
    expect(p.slice("elements/".length)).not.toMatch(/[\\/]/);
  });
});

describe("elementExport — directory mode", () => {
  it("writes element.html + assets/ sidecar and rewrites refs", async () => {
    const html = `<div class="card"><img src="https://example.test/hero.png"><span>hello</span></div>`;
    const css = `.card { color: red; }`;
    const locator = fakeLocator({
      html,
      css,
      resources: [
        {
          url: "https://example.test/hero.png",
          kind: "image",
          rawRef: "https://example.test/hero.png",
        },
      ],
    });
    const page = fakePage({
      "https://example.test/hero.png": {
        ok: true,
        base64: TINY_PNG_B64,
        contentType: "image/png",
        bytes: Buffer.from(TINY_PNG_B64, "base64").length,
      },
    });

    const r = await elementExport(page, locator, WS, "s1", {
      ref: "e1",
      intoDir: "el-1",
      format: "directory",
    });
    expect(r.ok).toBe(true);
    expect(r.format).toBe("directory");
    expect(r.ref).toBe("e1");
    expect(r.resourceCount).toBe(1);
    expect(r.droppedCount).toBe(0);
    expect(r.path).toBe(join(WS, "el-1"));

    const indexPath = join(r.path, "element.html");
    expect(existsSync(indexPath)).toBe(true);
    const written = readFileSync(indexPath, "utf8");
    expect(written).toContain(".card { color: red; }");
    expect(written).toContain("hello");
    expect(written).not.toContain("https://example.test/hero.png");
    expect(written).toContain("assets/images/");

    const imagesDir = join(r.path, "assets", "images");
    expect(readdirSync(imagesDir).length).toBe(1);

    expect(r.warnings.some((w) => w.toLowerCase().includes("unmasked"))).toBe(true);
  });

  it("falls back to a default workspace-rooted path", async () => {
    const locator = fakeLocator({ html: "<div></div>", css: "", resources: [] });
    const page = fakePage({});
    const r = await elementExport(page, locator, WS, "alpha", { ref: "e1" });
    expect(r.path.startsWith(join(WS, "elements", "alpha-"))).toBe(true);
    expect(r.path.endsWith("-e1")).toBe(true);
    expect(existsSync(join(r.path, "element.html"))).toBe(true);
  });
});

describe("elementExport — single-file mode", () => {
  it("inlines resources as data: URIs in one HTML file", async () => {
    const html = `<div><img src="https://example.test/hero.png"></div>`;
    const locator = fakeLocator({
      html,
      css: "",
      resources: [
        {
          url: "https://example.test/hero.png",
          kind: "image",
          rawRef: "https://example.test/hero.png",
        },
      ],
    });
    const page = fakePage({
      "https://example.test/hero.png": {
        ok: true,
        base64: TINY_PNG_B64,
        contentType: "image/png",
        bytes: Buffer.from(TINY_PNG_B64, "base64").length,
      },
    });

    const r = await elementExport(page, locator, WS, "s1", {
      ref: "e1",
      intoDir: "el.html",
      format: "single-file",
    });
    expect(r.ok).toBe(true);
    expect(r.format).toBe("single-file");
    expect(r.resourceCount).toBe(1);
    expect(r.path).toBe(join(WS, "el.html"));

    const written = readFileSync(r.path, "utf8");
    expect(written).toContain("data:image/png;base64,");
    expect(written).not.toContain("https://example.test/hero.png");
  });
});

describe("elementExport — workspace escape rejection", () => {
  it("rejects an intoDir that escapes the workspace", async () => {
    const locator = fakeLocator({ html: "", css: "", resources: [] });
    const page = fakePage({});
    await expect(
      elementExport(page, locator, WS, "s1", { ref: "e1", intoDir: "../escape" }),
    ).rejects.toThrow(/\$BROWX_WORKSPACE/);
  });

  it("rejects an absolute path outside the workspace", async () => {
    const locator = fakeLocator({ html: "", css: "", resources: [] });
    const page = fakePage({});
    await expect(
      elementExport(page, locator, WS, "s1", {
        ref: "e1",
        intoDir: "/tmp/escape.html",
        format: "single-file",
      }),
    ).rejects.toThrow(/\$BROWX_WORKSPACE/);
  });
});

describe("elementExport — ref-not-found", () => {
  it("throws a structured error when the locator matches zero elements", async () => {
    const locator = fakeLocator({ count: 0, html: "", css: "", resources: [] });
    const page = fakePage({});
    await expect(
      elementExport(page, locator, WS, "s1", { ref: "e99", intoDir: "nope" }),
    ).rejects.toThrow(/did not match any element/);
  });

  it("surfaces a count() failure as a structured error", async () => {
    const locator: ElementExportLocator = {
      async count() {
        throw new Error("locator dead");
      },
      async evaluate<T>(): Promise<T> {
        return {} as T;
      },
    };
    const page = fakePage({});
    await expect(
      elementExport(page, locator, WS, "s1", { ref: "ex", intoDir: "boom" }),
    ).rejects.toThrow(/did not resolve|locator dead/);
  });
});

describe("elementExport — maxSize enforcement", () => {
  it("drops resources past the byte budget and reports the cap warning", async () => {
    const big = "A".repeat(1024);
    const b64 = Buffer.from(big).toString("base64");
    const locator = fakeLocator({
      html: `<div><img src="https://a.test/1.png"><img src="https://a.test/2.png"></div>`,
      css: "",
      resources: [
        { url: "https://a.test/1.png", kind: "image", rawRef: "https://a.test/1.png" },
        { url: "https://a.test/2.png", kind: "image", rawRef: "https://a.test/2.png" },
      ],
    });
    const page = fakePage({
      "https://a.test/1.png": { ok: true, base64: b64, contentType: "image/png", bytes: 1024 },
      "https://a.test/2.png": { ok: true, base64: b64, contentType: "image/png", bytes: 1024 },
    });

    const r = await elementExport(page, locator, WS, "s1", {
      ref: "e1",
      intoDir: "small",
      format: "directory",
      maxSizeMb: 0.0015,
    });
    expect(r.resourceCount).toBe(1);
    expect(r.droppedCount).toBe(1);
    expect(r.warnings.some((w) => w.includes("maxSizeMb"))).toBe(true);
  });

  it("rejects a non-positive or absurd maxSizeMb up-front", async () => {
    const locator = fakeLocator({ html: "", css: "", resources: [] });
    const page = fakePage({});
    await expect(
      elementExport(page, locator, WS, "s1", { ref: "e1", intoDir: "x", maxSizeMb: 0 }),
    ).rejects.toThrow(/maxSizeMb/);
    await expect(
      elementExport(page, locator, WS, "s1", { ref: "e1", intoDir: "x", maxSizeMb: 100_000 }),
    ).rejects.toThrow(/maxSizeMb/);
  });
});

describe("elementExport — secrets-masking caveat always present", () => {
  it("warnings[] always includes the unmasked caveat", async () => {
    const locator = fakeLocator({ html: "<div/>", css: "", resources: [] });
    const page = fakePage({});
    const args: ElementExportArgs = { ref: "e1", intoDir: "warn", format: "directory" };
    const r = await elementExport(page, locator, WS, "s1", args);
    const has = r.warnings.some(
      (w) => w.includes("UNMASKED") || w.toLowerCase().includes("unmasked"),
    );
    expect(has).toBe(true);
  });

  it("surfaces the cross-origin stylesheet gap as a warning when detected", async () => {
    const locator = fakeLocator({
      html: "<div/>",
      css: "",
      resources: [],
      unreadableStylesheets: 2,
    });
    const page = fakePage({});
    const r = await elementExport(page, locator, WS, "s1", { ref: "e1", intoDir: "warn" });
    expect(r.warnings.some((w) => w.toLowerCase().includes("cross-origin"))).toBe(true);
  });
});

describe("elementExport — empty subtree", () => {
  it("writes the export with zero resources without error", async () => {
    const locator = fakeLocator({ html: `<div>hello</div>`, css: "", resources: [] });
    const page = fakePage({});
    const r = await elementExport(page, locator, WS, "s1", {
      ref: "e1",
      intoDir: "empty",
      format: "directory",
    });
    expect(r.resourceCount).toBe(0);
    expect(r.droppedCount).toBe(0);
    const idx = readFileSync(join(r.path, "element.html"), "utf8");
    expect(idx).toContain("hello");
    expect(statSync(r.path).isDirectory()).toBe(true);
  });
});
