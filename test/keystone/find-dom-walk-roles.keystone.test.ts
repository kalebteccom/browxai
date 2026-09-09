// find() tag-vs-ARIA-role keystone — real headless Chromium against the
// table-shaped `/thin-a11y-page` fixture, whose CDP a11y tree reports zero
// interactive descendants (snapshot `stats.a11yInteractive` is 0). Every
// candidate therefore comes from the DOM-walk fallback, which writes
// `getAttribute("role") || tagName` into `role`: the links arrive as role "a"
// and the top bar as role "nav".
//
// `find`'s interactive bonus and container demotion key off ARIA role names, so
// neither fired for any DOM-walk candidate until the resolution moved to the
// point of use. A mocked a11y tree cannot reproduce the configuration.
//
// The `role` assertions are the other half of the gate: `role` feeds
// `elementKey`, so normalising it at the merge would rotate every DOM-sourced
// ref. The emitted candidates must still carry the bare tag.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;
const QUERY = "the past link in the top navigation bar";

interface Candidate {
  ref: string;
  role: string;
  name?: string;
  testId?: string;
  score: number;
  actionable: true | "disabled" | "off-screen" | "covered";
  selectorHint: string;
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
  if (!fn) throw new Error(`find-dom-walk-roles keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function openOn(session: string): Promise<void> {
  const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
  expect(opened.ok).toBe(true);
  const nav = await callJson<{ ok: boolean }>("navigate", {
    session,
    url: `${fixture.url}/thin-a11y-page`,
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

describe("find keystone — DOM-walk candidates carry bare HTML tags", () => {
  it(
    "the a11y tree is thin, so the fixture exercises the fallback path",
    async () => {
      await openOn("ks-find-tag-roles-thin");
      const snap = (
        (await handlers["snapshot"]!({ session: "ks-find-tag-roles-thin" })).content[0] as {
          text: string;
        }
      ).text;
      expect(snap).toContain('"a11yInteractive":0');
      expect(snap).toContain('a "past"');
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "ranks the `past` link above the higher-scoring nav bar that encloses it",
    async () => {
      const session = "ks-find-tag-roles-rank";
      await openOn(session);

      const found = await callJson<{ candidates: Candidate[]; warnings: string[] }>("find", {
        session,
        query: QUERY,
        visibleOnly: true,
      });

      // Ordering is the property under test, not the exact candidate set: the
      // phrase ranker legitimately surfaces other matches between these two.
      const ids = found.candidates.map((c) => c.testId);
      const linkAt = ids.indexOf("past");
      const navAt = ids.indexOf("top-navigation-bar");
      expect(linkAt).toBe(0);
      expect(navAt).toBeGreaterThan(linkAt);

      const link = found.candidates[linkAt] as Candidate;
      const navBar = found.candidates[navAt] as Candidate;

      // Both are DOM-walk-sourced: the bare tag, never the resolved ARIA role.
      expect(link.role).toBe("a");
      expect(navBar.role).toBe("nav");

      // Container demotion on a bare `nav` is pinned deterministically in the
      // `rankByVisibility` unit tests. It is not asserted here: the phrase
      // ranker scores the exact-named link above the nav on this fixture
      // anyway, so a score comparison would prove nothing about demotion.

      // That the +2 interactive bonus fires on a bare-tag `<a>` is pinned as a
      // delta in the `scoreNode` unit tests; an absolute here would only re-bake
      // the whole scoring formula into a browser test.
      expect(link.score).toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "mints identical refs across re-finds — the resolution never reaches elementKey",
    async () => {
      const session = "ks-find-tag-roles-refs";
      await openOn(session);

      const first = await callJson<{ candidates: Candidate[] }>("find", { session, query: QUERY });
      const second = await callJson<{ candidates: Candidate[] }>("find", { session, query: QUERY });
      expect(first.candidates.length).toBeGreaterThan(0);
      expect(second.candidates.map((c) => c.ref)).toEqual(first.candidates.map((c) => c.ref));

      const snap = ((await handlers["snapshot"]!({ session })).content[0] as { text: string }).text;
      for (const c of first.candidates) expect(snap).toContain(`[ref=${c.ref}]`);
    },
    KEYSTONE_TIMEOUT,
  );
});
