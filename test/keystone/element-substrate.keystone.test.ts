// ElementSubstrate keystone — the verify_* family driven end-to-end against real
// headless Chromium after RFC 0009 P2 moved every read behind the element port,
// plus the Playwright fact the whole ambiguity amendment rests on.
//
// Two things a mock cannot establish:
//
//   1. `Locator.first().count()` is at most 1, whatever the selector matches.
//      That is why `locatorFor` — which narrows every tier through `.first()` —
//      makes `resolveTargetChecked`'s ambiguity branch unreachable, and why P2's
//      "preserve today's web behaviour" means preserving a SILENT first-match
//      pick rather than the warn-and-proceed the RFC describes.
//      `src/page/locator.test.ts`'s mock does not model it and its two ambiguity
//      cases pass against a shape Playwright does not have.
//
//   2. That the five verify tools still answer identically over a real DOM. The
//      unit lane mocks at the Locator boundary; this drives the registered MCP
//      handlers against a page with a deliberately duplicated test-id.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

/** Three rows sharing one test-id — the shape that makes a ref ambiguous — plus
 *  one uniquely-identified control the verify family asserts against. */
const AMBIGUOUS = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>element substrate keystone</title></head><body>
<div data-testid="row"><button data-testid="edit">Edit alpha</button></div>
<div data-testid="row"><button data-testid="edit">Edit beta</button></div>
<div data-testid="row"><button data-testid="edit">Edit gamma</button></div>
<input data-testid="email" value="you@example.com" aria-pressed="true">
<span data-testid="ghost" style="display:none">invisible</span>
</body></html>`;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;

async function callJson<T = Record<string, unknown>>(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await handlers[tool]!(args);
  return JSON.parse((res.content[0] as { text: string }).text) as T;
}

beforeAll(async () => {
  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
  await handlers.open_session!({ session: "element-substrate" });
  await handlers.navigate!({
    url: `data:text/html;base64,${Buffer.from(AMBIGUOUS).toString("base64")}`,
  });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.close?.();
  await fixture?.close();
}, KEYSTONE_TIMEOUT);

describe("Playwright `.first()` caps the count — the fact the amendment rests on", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(AMBIGUOUS);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
  }, KEYSTONE_TIMEOUT);

  it(
    "a bare locator counts every match; `.first()` counts one",
    async () => {
      expect(await page.locator('[data-testid="edit"]').count()).toBe(3);
      expect(
        await page.locator('[data-testid="edit"]').first().count(),
        "if this is ever > 1, `locatorFor`'s `.first()` narrowing stopped capping the " +
          "count and resolveTargetChecked's ambiguity branch just became reachable — " +
          "which is a live behaviour change, not a refactor",
      ).toBe(1);
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("verify_* over the element port, on a real DOM", () => {
  it(
    "an ambiguous ref resolves to the first match and never refuses",
    async () => {
      // `find` mints a ref for one of the three identical buttons; the recipe is
      // the shared test-id, so it is ambiguous by construction.
      const found = await callJson<{ candidates: Array<{ ref: string }> }>("find", {
        query: "Edit",
        maxCandidates: 5,
      });
      const ref = found.candidates[0]?.ref;
      expect(ref, "find produced no candidate to verify against").toBeTruthy();
      const visible = await callJson<{ ok: boolean; failure?: unknown; error?: string }>(
        "verify_visible",
        { ref },
      );
      expect(visible.ok, "an ambiguous ref must still verify, not refuse").toBe(true);
      expect(visible.error).toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "verify_count still counts every match, unnarrowed",
    async () => {
      const counted = await callJson<{ ok: boolean }>("verify_count", {
        selector: '[data-testid="edit"]',
        n: 3,
      });
      expect(counted.ok, "verify_count counts the collection, not `.first()`").toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "verify_text / verify_value / verify_attribute read through the port unchanged",
    async () => {
      // `.first()` narrowing means the ambiguous test-id reads the FIRST button's
      // text, which is the pick this phase preserves.
      expect(
        (
          await callJson<{ ok: boolean }>("verify_text", {
            selector: '[data-testid="edit"]',
            text: "Edit alpha",
            exact: true,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await callJson<{ ok: boolean }>("verify_value", {
            selector: '[data-testid="email"]',
            value: "you@example.com",
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await callJson<{ ok: boolean }>("verify_attribute", {
            selector: '[data-testid="email"]',
            attr: "aria-pressed",
            value: "true",
          })
        ).ok,
      ).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    'a hidden element fails as `source:"app"` with the computed reason',
    async () => {
      const body = await callJson<{
        ok: boolean;
        failure?: { source: string; actual: string };
      }>("verify_visible", { selector: '[data-testid="ghost"]' });
      expect(body.ok).toBe(false);
      expect(body.failure?.source).toBe("app");
      expect(body.failure?.actual).toBe("hidden (display:none)");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a selector that matches nothing is the `app` / stale half of the split",
    async () => {
      const body = await callJson<{
        ok: boolean;
        failure?: { source: string; actual: string };
      }>("verify_visible", { selector: "#definitely-absent" });
      expect(body.ok).toBe(false);
      expect(body.failure?.source).toBe("app");
      expect(body.failure?.actual).toBe("missing (locator matched 0 nodes)");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a ref the registry never held is the `browxai` / no-such-element half",
    async () => {
      const body = await callJson<{
        ok: boolean;
        failure?: { source: string; actual: string };
      }>("verify_visible", { ref: "e99999" });
      expect(body.ok).toBe(false);
      expect(body.failure?.source).toBe("browxai");
      expect(body.failure?.actual).toBe("ref no longer in the snapshot");
    },
    KEYSTONE_TIMEOUT,
  );
});
