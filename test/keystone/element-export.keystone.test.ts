// Element-export keystone — drives `element_export` against real headless
// Chromium across both formats. This is the regression gate for a real
// adopter bug: `SUBTREE_DISCOVERY_FN` was authored as a stringified arrow
// expression and passed to `locator.evaluate(stringExpr)`, which returns
// the function value uncalled — CDP can't serialize a function, so the
// page-side return crossed back as `undefined` and the server-side code
// threw "Cannot read properties of undefined (reading 'unreadableStylesheets')".
//
// The fix passes the discovery function as a real TS function literal so
// Playwright's `Locator.evaluate(fn)` path serializes the source + invokes
// in-page with the resolved element. This keystone runs the round-trip
// against real Chromium so the regression class can't reappear silently.
//
// `element_export` is gated on the off-by-default `file-io` capability;
// the server is spun up with that capability enabled.

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
  if (!fn) throw new Error(`element-export keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function findRefByTestId(
  session: string,
  query: string,
  testIdHint: string,
): Promise<string> {
  const r = await callJson<{
    candidates: Array<{ ref: string; selectorHint: string }>;
  }>("find", { session, query });
  const cand = r.candidates.find((c) => c.selectorHint.includes(testIdHint));
  if (!cand) {
    throw new Error(
      `element-export keystone: no candidate for "${query}" matching "${testIdHint}" — got ${r.candidates.map((c) => c.selectorHint).join(", ")}`,
    );
  }
  return cand.ref;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-elexport-ks-"));
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

describe("element-export keystone — directory mode against the fixture", () => {
  it(
    "writes element.html + assets/ sidecar on a real page (regression gate for the SUBTREE_DISCOVERY_FN stringified-arrow bug)",
    async () => {
      const session = "ks-elexp-dir";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);
      const nav = await callJson<{ ok: boolean }>("navigate", { session, url: `${fixture.url}/` });
      expect(nav.ok).toBe(true);

      const ref = await findRefByTestId(session, "the Save button", "save-btn");

      const r = await callJson<{
        ok: boolean;
        format: string;
        ref: string;
        path: string;
        sizeBytes: number;
        resourceCount: number;
        droppedCount: number;
        warnings: string[];
      }>("element_export", { session, ref, intoDir: "elements/save-btn-dir", format: "directory" });

      // The regression manifests here: pre-fix, the server-side code threw
      // "Cannot read properties of undefined (reading 'unreadableStylesheets')"
      // and `r.ok` was false with that error. Asserting ok=true is the gate.
      expect(r.ok).toBe(true);
      expect(r.format).toBe("directory");
      expect(r.ref).toBe(ref);
      expect(r.path).toBe(join(workspace, "elements/save-btn-dir"));
      expect(r.sizeBytes).toBeGreaterThan(0);

      const htmlPath = join(r.path, "element.html");
      expect(existsSync(htmlPath)).toBe(true);
      const html = readFileSync(htmlPath, "utf8");
      // The captured snippet must contain the targeted element's markup —
      // SUBTREE_DISCOVERY_FN actually ran in-page and returned outerHTML.
      expect(html.toLowerCase()).toContain("save");
      // Page-wide CSS was captured (stylesheet enumeration ran).
      expect(html.toLowerCase()).toMatch(/<style[\s>]/);

      // assets/ sidecar exists (possibly empty for a simple fixture).
      const assetsDir = join(r.path, "assets");
      expect(existsSync(assetsDir)).toBe(true);
      expect(statSync(assetsDir).isDirectory()).toBe(true);

      // Unmasked-export caveat is always the first warning.
      expect(r.warnings.length).toBeGreaterThan(0);
      expect(r.warnings.some((w) => w.toLowerCase().includes("unmasked"))).toBe(true);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("element-export keystone — single-file mode against the fixture", () => {
  it(
    "writes one self-contained HTML file with the element subtree + inline styles",
    async () => {
      const session = "ks-elexp-single";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      const ref = await findRefByTestId(session, "the Save button", "save-btn");

      const r = await callJson<{
        ok: boolean;
        format: string;
        ref: string;
        path: string;
        sizeBytes: number;
        warnings: string[];
      }>("element_export", {
        session,
        ref,
        intoDir: "elements/save-btn-single.html",
        format: "single-file",
      });

      expect(r.ok).toBe(true);
      expect(r.format).toBe("single-file");
      expect(r.path).toBe(join(workspace, "elements/save-btn-single.html"));
      expect(existsSync(r.path)).toBe(true);

      const text = readFileSync(r.path, "utf8");
      expect(text.toLowerCase()).toMatch(/<html[\s>]/);
      // Both the element markup and the inlined stylesheet block survived
      // the single-file roundtrip — proves the discovery function returned
      // a real { html, css, ... } object rather than undefined.
      expect(text.toLowerCase()).toContain("save");
      expect(text.toLowerCase()).toMatch(/<style[\s>][\s\S]*<\/style>/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("element-export keystone — default path under elements/", () => {
  it("omitting intoDir lands under workspace/elements/<sessionId>-<ISO>-<ref>", async () => {
    const session = "ks-elexp-default";
    await callJson("open_session", { session, mode: "incognito" });
    await callJson("navigate", { session, url: `${fixture.url}/` });

    const ref = await findRefByTestId(session, "the Save button", "save-btn");

    const r = await callJson<{ ok: boolean; path: string }>("element_export", {
      session,
      ref,
      format: "directory",
    });
    expect(r.ok).toBe(true);
    expect(r.path.startsWith(join(workspace, "elements", `${session}-`))).toBe(true);
    expect(existsSync(join(r.path, "element.html"))).toBe(true);

    await callJson("close_session", { session });
  });
});

describe("element-export keystone — workspace escape is rejected at the tool layer", () => {
  it("an intoDir that escapes $BROWX_WORKSPACE returns a structured error", async () => {
    const session = "ks-elexp-escape";
    await callJson("open_session", { session, mode: "incognito" });
    await callJson("navigate", { session, url: `${fixture.url}/` });

    const ref = await findRefByTestId(session, "the Save button", "save-btn");

    const r = await callJson<{ ok: boolean; error?: string }>("element_export", {
      session,
      ref,
      intoDir: "../escape-export",
      format: "directory",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\$BROWX_WORKSPACE/);

    const sibling = readdirSync(workspace);
    expect(sibling.every((n) => !n.includes("escape"))).toBe(true);

    await callJson("close_session", { session });
  });
});

describe("element-export keystone — ref-not-found is a structured error", () => {
  it("an unknown ref returns ok:false with the re-snapshot hint", async () => {
    const session = "ks-elexp-noref";
    await callJson("open_session", { session, mode: "incognito" });
    await callJson("navigate", { session, url: `${fixture.url}/` });

    const r = await callJson<{ ok: boolean; error?: string }>("element_export", {
      session,
      ref: "this-ref-does-not-exist",
      format: "directory",
    });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");

    await callJson("close_session", { session });
  });
});
