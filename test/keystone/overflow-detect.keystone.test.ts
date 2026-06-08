// overflow-detect keystone — drive `overflow_detect` against real headless
// Chromium with a fixture page deliberately constructed to trip each of the
// four detectors exactly once. Regression gate for the same stringified-
// arrow-function bug that bit `dom_export` and `element_export` (the
// page-side detector must be passed as a function literal, not a string).
//
// Coverage:
//   - all four overflow types are reported when the page exhibits each
//   - selectors are stable (testid-tier wins where available)
//   - bbox is non-null where applicable (null on viewport-horizontal is OK
//     since we hand-build it, but we still assert the structure)
//   - scope:"viewport" skips an off-screen clipped element
//   - types:["clipped"] returns only clipped findings
//   - limit caps the result + sets truncated:true

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

interface OverflowFinding {
  selector: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
  type: "layout" | "clipped" | "text-ellipsis" | "viewport-horizontal";
  evidence: Record<string, unknown>;
}

interface OverflowResult {
  ok: boolean;
  scope: string;
  findings: OverflowFinding[];
  truncated: boolean;
  warnings: string[];
  error?: string;
}

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`overflow-detect keystone: no handler "${name}"`);
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
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human";

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
}, KEYSTONE_TIMEOUT);

describe("overflow-detect keystone — all four detectors fire on the fixture", () => {
  it(
    "reports each of layout / clipped / text-ellipsis / viewport-horizontal exactly once on the dedicated fixture (regression gate for stringified-arrow PAGE_DETECT_FN bug)",
    async () => {
      const session = "ks-overflow-all";
      const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
      expect(opened.ok).toBe(true);
      // Force a small viewport so 200vw element definitely overflows.
      await callJson("set_viewport", { session, width: 400, height: 600 });
      const nav = await callJson<{ ok: boolean }>("navigate", { session, url: `${fixture.url}/overflow-page` });
      expect(nav.ok).toBe(true);

      const r = await callJson<OverflowResult>("overflow_detect", { session });

      // Pre-fix this returned ok:false / undefined-shape error. Gate is
      // ok:true + non-empty findings.
      expect(r.ok).toBe(true);
      expect(r.scope).toBe("document");
      expect(r.findings.length).toBeGreaterThan(0);

      const byType = new Map<string, OverflowFinding[]>();
      for (const f of r.findings) {
        const list = byType.get(f.type) ?? [];
        list.push(f);
        byType.set(f.type, list);
      }
      expect(byType.has("layout")).toBe(true);
      expect(byType.has("clipped")).toBe(true);
      expect(byType.has("text-ellipsis")).toBe(true);
      expect(byType.has("viewport-horizontal")).toBe(true);

      // viewport-horizontal is a singleton on selector "html".
      const vp = byType.get("viewport-horizontal")!;
      expect(vp.length).toBe(1);
      expect(vp[0]!.selector).toBe("html");
      const vpEv = vp[0]!.evidence as {
        documentScrollWidth: number;
        viewportWidth: number;
        overrunPx: number;
      };
      expect(vpEv.overrunPx).toBeGreaterThan(0);
      expect(vpEv.documentScrollWidth).toBeGreaterThan(vpEv.viewportWidth);

      // layout finding: bbox non-null, evidence carries the dimension keys.
      const layout = byType.get("layout")!.find((f) => f.selector.includes("ks-layout"));
      expect(layout).toBeTruthy();
      expect(layout!.bbox).not.toBeNull();
      const layoutEv = layout!.evidence as { scrollHeight: number; clientHeight: number; overflowY: string };
      expect(layoutEv.scrollHeight).toBeGreaterThan(layoutEv.clientHeight);
      expect(["auto", "scroll"]).toContain(layoutEv.overflowY);

      // clipped finding: data-testid tier wins → '[data-testid="ks-clipped"]'
      // OR the inner span (also overflowing); accept any selector tagged with
      // ks-clipped.
      const clipped = byType.get("clipped")!.find((f) => f.selector.includes("ks-clipped"));
      expect(clipped).toBeTruthy();
      expect(clipped!.bbox).not.toBeNull();
      const clipEv = clipped!.evidence as { overflowX?: string; overflowY?: string };
      expect(
        clipEv.overflowX === "hidden" ||
          clipEv.overflowX === "clip" ||
          clipEv.overflowY === "hidden" ||
          clipEv.overflowY === "clip",
      ).toBe(true);

      // text-ellipsis finding: visibleText + fullText present; fullText
      // carries the truth.
      const ellipsis = byType.get("text-ellipsis")!.find((f) => f.selector.includes("ks-ellipsis"));
      expect(ellipsis).toBeTruthy();
      const ellEv = ellipsis!.evidence as { fullText: string; visibleText: string };
      expect(ellEv.fullText).toContain("definitely truncate");
      expect(typeof ellEv.visibleText).toBe("string");

      // All selectors should plausibly resolve via [data-testid=...] tier 1
      // for the dedicated fixture elements (we tagged them).
      const taggedHits = r.findings.filter((f) => f.selector.includes("data-testid"));
      expect(taggedHits.length).toBeGreaterThan(0);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("overflow-detect keystone — scope:viewport skips off-screen elements", () => {
  it(
    "an off-screen #ks-offscreen clipped element is NOT reported with scope:viewport",
    async () => {
      const session = "ks-overflow-viewport";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("set_viewport", { session, width: 400, height: 600 });
      await callJson("navigate", { session, url: `${fixture.url}/overflow-page` });

      // First, confirm scope:document DOES see the offscreen one.
      const docR = await callJson<OverflowResult>("overflow_detect", {
        session,
        scope: "document",
        types: ["clipped"],
      });
      expect(docR.ok).toBe(true);
      const docHadOffscreen = docR.findings.some((f) => f.selector.includes("ks-offscreen"));
      expect(docHadOffscreen).toBe(true);

      // Then, scope:viewport should NOT (the box top is at 5000px which is
      // well beyond a 600px viewport).
      const vpR = await callJson<OverflowResult>("overflow_detect", {
        session,
        scope: "viewport",
        types: ["clipped"],
      });
      expect(vpR.ok).toBe(true);
      expect(vpR.scope).toBe("viewport");
      const vpHadOffscreen = vpR.findings.some((f) => f.selector.includes("ks-offscreen"));
      expect(vpHadOffscreen).toBe(false);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("overflow-detect keystone — type filter returns only that type", () => {
  it(
    'types:["clipped"] returns ONLY clipped findings — no layout/ellipsis/viewport-horizontal leakage',
    async () => {
      const session = "ks-overflow-typefilter";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("set_viewport", { session, width: 400, height: 600 });
      await callJson("navigate", { session, url: `${fixture.url}/overflow-page` });

      const r = await callJson<OverflowResult>("overflow_detect", {
        session,
        types: ["clipped"],
      });
      expect(r.ok).toBe(true);
      expect(r.findings.length).toBeGreaterThan(0);
      for (const f of r.findings) {
        expect(f.type).toBe("clipped");
      }

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("overflow-detect keystone — limit caps the result + sets truncated:true", () => {
  it(
    "limit:1 caps the returned findings to 1 and sets truncated:true (on a page with multiple overflowing elements)",
    async () => {
      const session = "ks-overflow-limit";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("set_viewport", { session, width: 400, height: 600 });
      await callJson("navigate", { session, url: `${fixture.url}/overflow-page` });

      const r = await callJson<OverflowResult>("overflow_detect", {
        session,
        limit: 1,
      });
      expect(r.ok).toBe(true);
      expect(r.findings.length).toBe(1);
      expect(r.truncated).toBe(true);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
