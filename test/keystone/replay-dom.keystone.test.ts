// DOM-capture keystone — drive `attachDomCapture` against a real headless
// Chromium. This is the regression gate for the whole DOM half of RFC 0007.
//
// What only a real browser can prove:
//   - the rrweb bundle is live BEFORE the page's first inline script runs. A
//     bundle that lands late snapshots an already-mutated DOM and the replay
//     starts from a page that never existed. A mocked context cannot see this.
//   - a full snapshot actually arrives and carries the real DOM, including
//     shadow roots and a same-origin iframe.
//   - later mutations arrive as INCREMENTAL events, not as a second snapshot.
//   - a password field's value never reaches the stream, on either the
//     full-snapshot path or the incremental-input path.
//
// Deliberately drives the module directly rather than an MCP tool: no tool
// surface is wired to it yet, and the injection seam is the thing under test.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { attachDomCapture, type DomCaptureHandle } from "../../src/replay/dom-capture.js";
import type { ReplayEvent } from "../../src/replay/schema.js";

const KEYSTONE_TIMEOUT = 120_000;

/** rrweb's own event-type numbering. Asserted against the numbers, not against
 *  an import, because the payload crosses as plain JSON. */
const RRWEB_FULL_SNAPSHOT = 2;
const RRWEB_INCREMENTAL = 3;

/** The value that must never appear anywhere in the captured stream. */
const PASSWORD = "hunter2-must-never-reach-the-stream";
const PLAIN_TEXT = "plain-text-value-may-appear";

const FRAME_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>frame</title></head>
<body><p id="frame-text">IFRAME-MARKER</p></body></html>`;

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>rrweb keystone</title>
<script>
  // The page's FIRST script. If the bundle were injected any later than
  // addInitScript, this probe would see nothing.
  window.__browxFirstScriptSaw = {
    rrwebType: typeof window.rrweb,
    hasRecord: !!(window.rrweb && typeof window.rrweb.record === "function"),
    installedFlag: window.__browx_rrweb_installed === true,
    readyState: document.readyState,
    bodyExists: !!document.body
  };
</script>
</head>
<body>
  <div id="initial">INITIAL-MARKER</div>

  <div id="shadow-host"></div>
  <script>
    (function () {
      var root = document.getElementById("shadow-host").attachShadow({ mode: "open" });
      root.innerHTML = '<p id="shadow-text">SHADOW-MARKER</p>';
    })();
  </script>

  <iframe id="frame" src="/frame" width="200" height="80"></iframe>

  <label for="pw">Password</label>
  <input id="pw" name="pw" type="password" autocomplete="off" />
  <label for="plain">Plain</label>
  <input id="plain" name="plain" type="text" />

  <button id="add" type="button" onclick="
    var d = document.createElement('div');
    d.id = 'added';
    d.textContent = 'MUTATION-MARKER';
    document.body.appendChild(d);
  ">add</button>
</body></html>`;

interface Fixture {
  url: string;
  close: () => Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const server: Server = createServer((req, res) => {
    const body = (req.url ?? "/").startsWith("/frame") ? FRAME_PAGE : PAGE;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const chromePath = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const describeDom = chromePath && existsSync(chromePath) ? describe : describe.skip;

let fixture: Fixture;
let browser: Browser;

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
}, KEYSTONE_TIMEOUT);

interface Capture {
  context: BrowserContext;
  handle: DomCaptureHandle;
  events: ReplayEvent<{ type?: number }>[];
  close: () => Promise<void>;
}

async function startCapture(maskSelectors: string[] = []): Promise<Capture> {
  const context = await browser.newContext();
  const events: ReplayEvent<{ type?: number }>[] = [];
  const handle = await attachDomCapture(context, {
    clockOrigin: Date.now(),
    maskSelectors,
    onEvent: (e) => events.push(e as ReplayEvent<{ type?: number }>),
  });
  return {
    context,
    handle,
    events,
    close: async () => {
      await handle.detach().catch(() => undefined);
      await context.close().catch(() => undefined);
    },
  };
}

async function settle(cap: Capture, want: (events: Capture["events"]) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (want(cap.events)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function stream(cap: Capture): string {
  return JSON.stringify(cap.events);
}

describeDom("replay DOM capture keystone — rrweb against real Chromium", () => {
  it(
    "injects the recorder before the page's first script, and the full snapshot carries the real DOM",
    async () => {
      const cap = await startCapture();
      try {
        const page = await cap.context.newPage();
        await page.goto(`${fixture.url}/`, { waitUntil: "load" });

        const probe = await page.evaluate(
          () => (globalThis as unknown as { __browxFirstScriptSaw: unknown }).__browxFirstScriptSaw,
        );
        // The page's own first inline script already saw a live recorder.
        expect(probe).toMatchObject({
          rrwebType: "object",
          hasRecord: true,
          installedFlag: true,
          readyState: "loading",
        });

        await settle(cap, (e) => e.some((x) => x.payload.type === RRWEB_FULL_SNAPSHOT));
        const snapshots = cap.events.filter((e) => e.payload.type === RRWEB_FULL_SNAPSHOT);
        expect(snapshots.length).toBeGreaterThanOrEqual(1);

        // Every event is the browxai envelope, the rrweb event untouched inside it.
        for (const e of cap.events) {
          expect(e.type).toBe("dom/rrweb");
          expect(e.v).toBe(1);
          expect(typeof e.t).toBe("number");
        }

        const snapshotText = JSON.stringify(snapshots);
        expect(snapshotText).toContain("INITIAL-MARKER");
        // Shadow DOM and the same-origin iframe are captured too.
        expect(snapshotText).toContain("SHADOW-MARKER");
        await settle(cap, () => stream(cap).includes("IFRAME-MARKER"));
        expect(stream(cap)).toContain("IFRAME-MARKER");
      } finally {
        await cap.close();
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "delivers subsequent mutations as incremental events, not as another full snapshot",
    async () => {
      const cap = await startCapture();
      try {
        const page = await cap.context.newPage();
        await page.goto(`${fixture.url}/`, { waitUntil: "load" });
        await settle(cap, (e) => e.some((x) => x.payload.type === RRWEB_FULL_SNAPSHOT));

        const snapshotsBefore = cap.events.filter(
          (e) => e.payload.type === RRWEB_FULL_SNAPSHOT,
        ).length;
        const marker = () =>
          cap.events.filter(
            (e) =>
              e.payload.type === RRWEB_INCREMENTAL && JSON.stringify(e).includes("MUTATION-MARKER"),
          );

        await page.click("#add");
        await settle(cap, () => marker().length > 0);

        expect(marker().length).toBeGreaterThanOrEqual(1);
        expect(cap.events.filter((e) => e.payload.type === RRWEB_FULL_SNAPSHOT).length).toBe(
          snapshotsBefore,
        );
      } finally {
        await cap.close();
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "never lets a password field's value reach the stream, on the incremental or the snapshot path",
    async () => {
      const cap = await startCapture();
      try {
        const page = await cap.context.newPage();
        await page.goto(`${fixture.url}/`, { waitUntil: "load" });
        await settle(cap, (e) => e.some((x) => x.payload.type === RRWEB_FULL_SNAPSHOT));

        // Typed, so rrweb's input observer fires on every keystroke — the
        // incremental path a `fill` would skip.
        await page.click("#pw");
        await page.type("#pw", PASSWORD, { delay: 1 });
        await page.click("#plain");
        await page.type("#plain", PLAIN_TEXT, { delay: 1 });

        // A second full snapshot re-serialises the DOM with the password
        // already in the field — the other path the value could escape by.
        await page.evaluate(() =>
          (
            globalThis as unknown as { rrweb: { record: { takeFullSnapshot(): void } } }
          ).rrweb.record.takeFullSnapshot(),
        );

        await settle(cap, () => stream(cap).includes(PLAIN_TEXT));
        expect(await page.inputValue("#pw")).toBe(PASSWORD);

        const captured = stream(cap);
        // The evidence: the real value is in the live DOM and absent from the
        // stream, while a non-sensitive field on the same page came through.
        expect(captured).not.toContain(PASSWORD);
        expect(captured).not.toContain(PASSWORD.slice(0, 12));
        expect(captured).toContain(PLAIN_TEXT);
        expect(captured).toContain("*".repeat(PASSWORD.length));
      } finally {
        await cap.close();
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "masks a configured selector on top of the password default",
    async () => {
      const cap = await startCapture(["#plain"]);
      try {
        const page = await cap.context.newPage();
        await page.goto(`${fixture.url}/`, { waitUntil: "load" });
        await settle(cap, (e) => e.some((x) => x.payload.type === RRWEB_FULL_SNAPSHOT));

        await page.click("#plain");
        await page.type("#plain", PLAIN_TEXT, { delay: 1 });
        await settle(cap, () => stream(cap).includes("*".repeat(PLAIN_TEXT.length)));

        const captured = stream(cap);
        expect(captured).not.toContain(PLAIN_TEXT);
        expect(captured).toContain("*".repeat(PLAIN_TEXT.length));
      } finally {
        await cap.close();
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "omits targetId on a single-tab session and writes it once a second tab opens",
    async () => {
      const cap = await startCapture();
      try {
        const first = await cap.context.newPage();
        await first.goto(`${fixture.url}/`, { waitUntil: "load" });
        await settle(cap, (e) => e.some((x) => x.payload.type === RRWEB_FULL_SNAPSHOT));

        expect(cap.events.length).toBeGreaterThan(0);
        for (const e of cap.events) expect("targetId" in e).toBe(false);

        const second = await cap.context.newPage();
        await second.goto(`${fixture.url}/`, { waitUntil: "load" });
        await settle(cap, (e) => e.some((x) => x.targetId !== undefined));

        const tagged = cap.events.filter((e) => e.targetId !== undefined);
        expect(tagged.length).toBeGreaterThan(0);
        expect(new Set(tagged.map((e) => e.targetId)).size).toBeGreaterThanOrEqual(1);
      } finally {
        await cap.close();
      }
    },
    KEYSTONE_TIMEOUT,
  );
});
