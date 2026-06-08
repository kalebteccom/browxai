// dom-export keystone — drive `dom_export` against real headless Chromium
// in both formats. Regression gate for the second instance of the
// stringified-arrow-function bug (PAGE_WALK_FN): the function was authored
// as `(args) => {...}` passed to `page.evaluate(stringExpr, arg)`, which
// evaluates the string in page context and returns the function value
// uncalled — CDP can't serialize a function so the result crossed back as
// undefined and the server-side `walked.nodeCount` access threw "Cannot
// read properties of undefined (reading 'nodeCount')". Sibling to
// element-export.keystone.test.ts (same fix shape).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
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
  if (!fn) throw new Error(`dom-export keystone: no handler "${name}"`);
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
  workspace = mkdtempSync(join(tmpdir(), "browx-domexp-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
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

describe("dom-export keystone — html mode against the fixture", () => {
  it(
    "writes a self-contained .html dump with non-zero nodeCount (regression gate for stringified-arrow PAGE_WALK_FN bug)",
    async () => {
      const session = "ks-dom-html";
      const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
      expect(opened.ok).toBe(true);
      const nav = await callJson<{ ok: boolean }>("navigate", { session, url: `${fixture.url}/` });
      expect(nav.ok).toBe(true);

      const r = await callJson<{
        ok: boolean;
        format: string;
        path: string;
        sizeBytes: number;
        nodeCount: number;
        shadowRootCount: number;
        warnings: string[];
      }>("dom_export", { session, path: "dom-dumps/fixture.html", format: "html" });

      // Pre-fix this returned ok:false with the "Cannot read properties of
      // undefined (reading 'nodeCount')" error — the gate is ok:true plus
      // nodeCount > 0 (proves PAGE_WALK_FN actually ran in-page).
      expect(r.ok).toBe(true);
      expect(r.format).toBe("html");
      expect(r.path).toBe(join(workspace, "dom-dumps/fixture.html"));
      expect(r.sizeBytes).toBeGreaterThan(0);
      expect(r.nodeCount).toBeGreaterThan(0);
      expect(existsSync(r.path)).toBe(true);

      const html = readFileSync(r.path, "utf8");
      expect(html.toLowerCase()).toMatch(/<html[\s>]/);
      expect(html).toContain("Keystone Fixture");

      // Secrets-masking caveat is always present.
      expect(r.warnings.some((w) => w.toLowerCase().includes("unmasked"))).toBe(true);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("dom-export keystone — jsonl mode against the fixture", () => {
  it(
    "writes one JSON object per line, lines === nodeCount, each line parses",
    async () => {
      const session = "ks-dom-jsonl";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      const r = await callJson<{
        ok: boolean;
        format: string;
        path: string;
        sizeBytes: number;
        nodeCount: number;
        shadowRootCount: number;
      }>("dom_export", { session, path: "dom-dumps/fixture.jsonl", format: "jsonl" });

      expect(r.ok).toBe(true);
      expect(r.format).toBe("jsonl");
      expect(r.path).toBe(join(workspace, "dom-dumps/fixture.jsonl"));
      expect(r.sizeBytes).toBeGreaterThan(0);
      expect(r.nodeCount).toBeGreaterThan(0);
      expect(existsSync(r.path)).toBe(true);

      // Every non-empty line parses, and the count matches.
      const lines = readFileSync(r.path, "utf8").split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(r.nodeCount);
      for (const line of lines.slice(0, 5)) {
        const obj = JSON.parse(line);
        expect(obj).toHaveProperty("tag");
        expect(obj).toHaveProperty("depth");
        expect(obj).toHaveProperty("attrs");
      }

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("dom-export keystone — default path under dom-dumps/", () => {
  it("omitting path lands under workspace/dom-dumps/<sessionId>-<ISO>.<ext>", async () => {
    const session = "ks-dom-default";
    await callJson("open_session", { session, mode: "incognito" });
    await callJson("navigate", { session, url: `${fixture.url}/` });

    const r = await callJson<{ ok: boolean; path: string }>("dom_export", {
      session,
      format: "html",
    });
    expect(r.ok).toBe(true);
    expect(r.path.startsWith(join(workspace, "dom-dumps", `${session}-`))).toBe(true);
    expect(r.path.endsWith(".html")).toBe(true);
    expect(existsSync(r.path)).toBe(true);

    await callJson("close_session", { session });
  });
});

describe("dom-export keystone — workspace escape is rejected at the tool layer", () => {
  it("a path that escapes $BROWX_WORKSPACE returns a structured error", async () => {
    const session = "ks-dom-escape";
    await callJson("open_session", { session, mode: "incognito" });
    await callJson("navigate", { session, url: `${fixture.url}/` });

    const r = await callJson<{ ok: boolean; error?: string }>("dom_export", {
      session,
      path: "../escape-dom.html",
      format: "html",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\$BROWX_WORKSPACE/);

    const sibling = readdirSync(workspace);
    expect(sibling.every((n) => !n.includes("escape"))).toBe(true);

    await callJson("close_session", { session });
  });
});
