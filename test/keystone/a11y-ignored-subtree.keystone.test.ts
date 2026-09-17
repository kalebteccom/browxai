// a11y ignored-subtree keystone — real headless Chromium against
// `/ignored-wrapper-page`, whose controls sit under wrappers CDP reports as
// `ignored`.
//
// `Accessibility.getFullAXTree` marks a node `ignored` when THAT node is not
// exposed to assistive tech. The conversion in `a11y.ts` used to return null on
// one and never recurse, taking the whole subtree with it. Chromium marks
// `<html>` and `<body>` ignored (`ignoredReasons: [uninteresting]`) on
// essentially every page, so the a11y tier emitted a bare root and every
// snapshot was carried by the DOM-walk fallback — silently, because the
// fallback answers.
//
// Only a real browser produces the ignored/exposed interleaving: a mocked tree
// is whatever the fixture author believed Chromium does. The unit fixtures in
// `src/page/a11y.test.ts` were written from this page's actual CDP output.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
const savedEnv: Record<string, string | undefined> = {};

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`a11y-ignored-subtree keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await callText(name, args)) as T;
}

/** Snapshot lines the a11y tier produced. DOM-walk entries carry `[from-dom]`
 *  and nodes both tiers found carry `[from-both]`; everything else came from
 *  the CDP accessibility tree. */
function a11yLines(snapshot: string): string[] {
  return snapshot
    .split("\n")
    .filter((l) => l.includes("[ref=") && !l.includes("[from-dom]") && !l.includes("[from-both]"));
}

function statsOf(snapshot: string): { a11yInteractive: number; tier: string } {
  const line = snapshot.split("\n").find((l) => l.startsWith("stats: "));
  if (!line) throw new Error(`no stats line in snapshot:\n${snapshot}`);
  return JSON.parse(line.slice("stats: ".length)) as { a11yInteractive: number; tier: string };
}

async function openOn(session: string): Promise<void> {
  const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
  expect(opened.ok).toBe(true);
  const nav = await callJson<{ ok: boolean }>("navigate", {
    session,
    url: `${fixture.url}/ignored-wrapper-page`,
  });
  expect(nav.ok).toBe(true);
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

describe("a11y keystone — ignored wrappers do not eat their subtree", () => {
  it(
    "surfaces controls under presentational wrappers through the a11y tier",
    async () => {
      const session = "ks-a11y-ignored-read";
      await openOn(session);
      const snap = await callText("snapshot", { session });
      const fromA11y = a11yLines(snap).join("\n");

      // Every one of these sits under at least two ignored nodes (`<html>`,
      // `<body>`) plus its own presentational wrapper.
      expect(fromA11y).toContain('button "Presentational Child"');
      expect(fromA11y).toContain('button "Layout Table Child"');
      expect(fromA11y).toContain('link "Presentational List Link"');

      // Two buttons and a link, all under ignored wrappers. Pre-fix this page
      // reported `a11yInteractive: 0` and `tier: "dom-walk"`.
      expect(statsOf(snap).a11yInteractive).toBeGreaterThanOrEqual(3);
      expect(statsOf(snap).tier).toBe("mixed");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "keeps an aria-hidden subtree out of the a11y tier",
    async () => {
      // `aria-hidden` marks the container AND its descendants ignored, so
      // splicing must surface nothing from it. (The DOM-walk fallback still
      // reports it — that tier is not a11y-aware and never was.)
      const session = "ks-a11y-ignored-hidden";
      await openOn(session);
      const snap = await callText("snapshot", { session });
      const fromA11y = a11yLines(snap).join("\n");
      // The presentational sibling is the control: splicing runs on this page.
      expect(fromA11y).toContain('button "Presentational Child"');
      expect(fromA11y).not.toContain("Aria Hidden Child");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "mints refs that resolve back to a clickable element",
    async () => {
      // A ref is a locator recipe re-resolved at action time. A spliced node
      // whose ref cannot be acted on would be a snapshot that lies.
      const session = "ks-a11y-ignored-act";
      await openOn(session);
      const snap = await callText("snapshot", { session });
      const line = a11yLines(snap).find((l) => l.includes('button "Presentational Child"'));
      expect(line, "presentational button present in the a11y tier").toBeTruthy();
      const ref = /\[ref=(e\d+)\]/.exec(line!)?.[1];
      expect(ref, `no ref on line: ${line}`).toBeTruthy();

      const clicked = await callJson<{ ok: boolean }>("click", { session, ref });
      expect(clicked.ok).toBe(true);
      expect(await callText("snapshot", { session })).toContain("presentational-clicked");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "keeps the ref stable across re-snapshots",
    async () => {
      const session = "ks-a11y-ignored-stable";
      await openOn(session);
      const first = a11yLines(await callText("snapshot", { session }));
      const second = a11yLines(await callText("snapshot", { session }));
      expect(first.some((l) => l.includes('button "Presentational Child"'))).toBe(true);
      expect(second).toEqual(first);
    },
    KEYSTONE_TIMEOUT,
  );
});
