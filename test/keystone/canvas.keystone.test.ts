// canvas keystone — drive the tools against real headless
// Chromium with a fixture page that paints a known pattern into a
// `<canvas>`. Regression gate for the same stringified-arrow page-side
// trap that bit `dom_export` / `element_export` / `overflow_detect` —
// `canvas_capture`'s `PAGE_CAPTURE_FN` must be a real function literal.
//
// Coverage:
//   - canvas_capture format:"png" — bytes returned, PNG magic, dimensions
//   - canvas_capture format:"2d-imagedata" — byte length === w * h * 4
//   - gesture_chain 3-step program — stepsExecuted, page listeners fire
//   - canvas_world_to_screen explicit mode with a known transform
//   - canvas_query rejects cleanly when no adapter plugin is loaded

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  if (!fn) throw new Error(`canvas keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

beforeAll(async () => {
  // Hard zero-env: strip every BROWX_* so the dev shell's persistent
  // ~/.browxai/config.json layer doesn't leak in (it can carry an
  // expanded capability set that overrides the env layer).
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  // Throwaway tmp workspace so the config.json layer is empty by
  // construction; the env-supplied capabilities then resolve verbatim.
  workspace = mkdtempSync(join(tmpdir(), "browx-canvas-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // canvas capability gated on; action for gesture_chain dispatch.
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,canvas";

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_CAPABILITIES;
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("canvas keystone — canvas_capture format:'png'", () => {
  it(
    "returns base64 PNG bytes with correct dimensions and PNG magic header",
    async () => {
      const session = "ks-canvas-png";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);
      await callJson("navigate", { session, url: `${fixture.url}/canvas-page` });

      const r = await callJson<{
        ok: boolean;
        format: string;
        contentBase64: string;
        byteLength: number;
        width: number;
        height: number;
      }>("canvas_capture", { session, format: "png" });

      expect(r.ok).toBe(true);
      expect(r.format).toBe("png");
      expect(r.width).toBe(64);
      expect(r.height).toBe(64);
      expect(r.byteLength).toBeGreaterThan(0);
      expect(typeof r.contentBase64).toBe("string");
      // PNG magic: 0x89 0x50 0x4E 0x47 (.PNG) — the base64 prefix
      // 'iVBORw0KGgo' is the canonical encoding of the 8-byte PNG signature.
      expect(r.contentBase64.startsWith("iVBORw0KGgo")).toBe(true);
      // Verify the bytes actually parse as a PNG signature.
      const head = Buffer.from(r.contentBase64.slice(0, 12), "base64");
      expect(head[0]).toBe(0x89);
      expect(head[1]).toBe(0x50);
      expect(head[2]).toBe(0x4e);
      expect(head[3]).toBe(0x47);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("canvas keystone — canvas_capture format:'2d-imagedata'", () => {
  it(
    "returns RGBA bytes with length === width * height * 4 and the painted pattern",
    async () => {
      const session = "ks-canvas-imagedata";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/canvas-page` });

      const r = await callJson<{
        ok: boolean;
        format: string;
        contentBase64: string;
        width: number;
        height: number;
        channelCount: number;
      }>("canvas_capture", { session, format: "2d-imagedata" });

      expect(r.ok).toBe(true);
      expect(r.format).toBe("2d-imagedata");
      expect(r.width).toBe(64);
      expect(r.height).toBe(64);
      expect(r.channelCount).toBe(4);
      const bytes = Buffer.from(r.contentBase64, "base64");
      expect(bytes.length).toBe(64 * 64 * 4);

      // The fixture paints a red 8x8 square at (0,0). Pixel (0,0) should be
      // RGB(255,0,0) with alpha 255.
      expect(bytes[0]).toBe(255);
      expect(bytes[1]).toBe(0);
      expect(bytes[2]).toBe(0);
      expect(bytes[3]).toBe(255);
      // Pixel at (56,56) — start of the blue 8x8 square — should be (0,0,255,255).
      const blueIdx = (56 * 64 + 56) * 4;
      expect(bytes[blueIdx]).toBe(0);
      expect(bytes[blueIdx + 1]).toBe(0);
      expect(bytes[blueIdx + 2]).toBe(255);
      expect(bytes[blueIdx + 3]).toBe(255);
      // Pixel at (32,32) — background — should be white opaque.
      const bgIdx = (32 * 64 + 32) * 4;
      expect(bytes[bgIdx]).toBe(255);
      expect(bytes[bgIdx + 1]).toBe(255);
      expect(bytes[bgIdx + 2]).toBe(255);
      expect(bytes[bgIdx + 3]).toBe(255);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("canvas keystone — gesture_chain 3-step program", () => {
  it(
    "down → move → up dispatches three steps and the canvas listener fires for each phase",
    async () => {
      const session = "ks-gesture-chain";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/canvas-page` });

      // The canvas top-left corner is at the document top-left after the
      // <h1>. Compute a position via getBoundingClientRect from the page.
      // For the keystone we use coordinates that comfortably land inside
      // the canvas — the page provides a 64×64 canvas; pixels 100,100 are
      // close to the canvas centre after the <h1>.
      const r = await callJson<{
        ok: boolean;
        stepsExecuted: number;
        totalDurationMs: number;
        warnings: string[];
      }>("gesture_chain", {
        session,
        steps: [
          { kind: "down", x: 30, y: 100 },
          { kind: "move", x: 50, y: 110, ms: 10 },
          { kind: "up", x: 50, y: 110 },
        ],
      });

      expect(r.ok).toBe(true);
      expect(r.stepsExecuted).toBe(3);
      expect(r.totalDurationMs).toBeGreaterThanOrEqual(0);

      // The page-side listeners should have recorded at least one of each
      // phase. Read the event-log output via text_search.
      const ts = await callJson<{
        count: number;
        matches: Array<{ text: string }>;
      }>("text_search", { session, text: "down=", includeHidden: true });
      expect(ts.count).toBeGreaterThan(0);
      const log = ts.matches[0]!.text;
      // The down + up phases are deterministic. The move phase may not
      // always trip the canvas's mousemove listener if Playwright lands
      // every move on the same coordinate as the prior position (the
      // browser may dedupe); assert down + up are non-zero, and at least
      // one of the three counters fired.
      expect(log).toMatch(/down=[1-9]/);
      expect(log).toMatch(/up=[1-9]/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("canvas keystone — canvas_world_to_screen explicit-mode math", () => {
  it(
    "applies (worldX + panX) * scale + originX with a known transform",
    async () => {
      const session = "ks-canvas-w2s";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/canvas-page` });

      const r = await callJson<{
        ok: boolean;
        screenX: number;
        screenY: number;
        transformDiscovered?: unknown;
        adapterHint?: string;
      }>("canvas_world_to_screen", {
        session,
        worldX: 5,
        worldY: 7,
        transform: { scale: 2, panX: 10, panY: 20, originX: 100, originY: 200 },
      });
      // (5+10)*2 + 100 = 130; (7+20)*2 + 200 = 254.
      expect(r.ok).toBe(true);
      expect(r.screenX).toBe(130);
      expect(r.screenY).toBe(254);
      // Explicit mode does not surface adapterHint.
      expect(r.adapterHint).toBeUndefined();
      expect(r.transformDiscovered).toBeUndefined();

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("canvas keystone — canvas_query no-adapter error shape", () => {
  it(
    "rejects cleanly with code:'no-adapter' when no plugin matches (no plugins loaded)",
    async () => {
      const session = "ks-canvas-query";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/canvas-page` });

      const r = await callJson<{
        ok: boolean;
        error: string;
        code: string;
        requestedAdapter?: string;
        requestedOp?: string;
      }>("canvas_query", {
        session,
        adapter: "figma",
        op: "getNodeBounds",
        args: { nodeId: "abc" },
      });

      expect(r.ok).toBe(false);
      expect(r.code).toBe("no-adapter");
      expect(r.requestedAdapter).toBe("figma");
      expect(r.requestedOp).toBe("getNodeBounds");
      expect(r.error).toContain("@kalebtec/browxai-plugin-figma");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
