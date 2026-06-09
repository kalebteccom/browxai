// Page-archive keystone — drive a real headless Chromium against the fixture,
// archive the page in both modes, assert the output structure on disk.
//
// `page_archive` is gated on the off-by-default `file-io` capability and
// resolved ONCE at server start. We spin up our own server here with the
// capability enabled so the gate doesn't refuse the call. Single-fork
// keystone harness — the fixture http server + this server own the process.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`page-archive keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-archive-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  // Enable `file-io` for the lifetime of this server — page_archive's gate.
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,file-io";

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("page-archive keystone — directory mode against the fixture", () => {
  it(
    "writes index.html + assets/ sidecar with non-zero size on a real page",
    async () => {
      const session = "ks-archive-dir";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);

      const nav = await callJson<{ ok: boolean }>("navigate", { session, url: `${fixture.url}/` });
      expect(nav.ok).toBe(true);

      const r = await callJson<{
        ok: boolean;
        format: string;
        path: string;
        sizeBytes: number;
        resourceCount: number;
        droppedCount: number;
        warnings: string[];
      }>("page_archive", { session, path: "archives/fixture-dir", format: "directory" });

      expect(r.ok).toBe(true);
      expect(r.format).toBe("directory");
      expect(r.path).toBe(join(workspace, "archives/fixture-dir"));
      expect(r.sizeBytes).toBeGreaterThan(0);
      // The fixture page is minimal (inline CSS, no external assets) — but
      // the index.html itself must exist and carry the page's title.
      const indexPath = join(r.path, "index.html");
      expect(existsSync(indexPath)).toBe(true);
      const html = readFileSync(indexPath, "utf8");
      expect(html).toContain("Keystone Fixture");
      // Secrets-masking caveat is always present.
      expect(r.warnings.some((w) => w.toLowerCase().includes("unmasked"))).toBe(true);
      // assets/ sidecar exists (possibly empty for the asset-less fixture).
      const assetsDir = join(r.path, "assets");
      expect(existsSync(assetsDir)).toBe(true);
      expect(statSync(assetsDir).isDirectory()).toBe(true);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("page-archive keystone — single-file mode against the fixture", () => {
  it(
    "writes one self-contained HTML file the agent can re-open",
    async () => {
      const session = "ks-archive-single";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      const r = await callJson<{
        ok: boolean;
        format: string;
        path: string;
        sizeBytes: number;
        resourceCount: number;
        droppedCount: number;
      }>("page_archive", {
        session,
        path: "archives/fixture-single.html",
        format: "single-file",
      });

      expect(r.ok).toBe(true);
      expect(r.format).toBe("single-file");
      expect(r.path).toBe(join(workspace, "archives/fixture-single.html"));
      expect(existsSync(r.path)).toBe(true);
      const text = readFileSync(r.path, "utf8");
      expect(text).toContain("Keystone Fixture");
      // Single-file mode produces a real HTML document. Note
      // `documentElement.outerHTML` excludes the `<!doctype>` node (it's a
      // sibling of `<html>`, not a descendant), so we assert on the root
      // element instead.
      expect(text.toLowerCase()).toMatch(/<html[\s>]/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("page-archive keystone — workspace escape is rejected at the tool layer", () => {
  it("a path that escapes $BROWX_WORKSPACE returns a structured error", async () => {
    const session = "ks-archive-escape";
    await callJson("open_session", { session, mode: "incognito" });
    await callJson("navigate", { session, url: `${fixture.url}/` });

    const r = await callJson<{ ok: boolean; error?: string }>("page_archive", {
      session,
      path: "../escape-archive",
      format: "directory",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\$BROWX_WORKSPACE/);

    // No directory was created at the escape target.
    const sibling = readdirSync(workspace);
    expect(sibling.every((n) => !n.includes("escape"))).toBe(true);

    await callJson("close_session", { session });
  });
});

describe("page-archive keystone — default path under archives/", () => {
  it("omitting path lands under workspace/archives/<sessionId>-<ISO>", async () => {
    const session = "ks-archive-default";
    await callJson("open_session", { session, mode: "incognito" });
    await callJson("navigate", { session, url: `${fixture.url}/` });

    const r = await callJson<{ ok: boolean; path: string }>("page_archive", {
      session,
      format: "directory",
    });
    expect(r.ok).toBe(true);
    expect(r.path.startsWith(join(workspace, "archives", `${session}-`))).toBe(true);
    expect(existsSync(join(r.path, "index.html"))).toBe(true);

    await callJson("close_session", { session });
  });
});
