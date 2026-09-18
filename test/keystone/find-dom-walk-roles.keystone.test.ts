// find() tag-vs-ARIA-role keystone — real headless Chromium against the
// table-shaped `/thin-a11y-page` fixture. The DOM-walk fallback writes
// `getAttribute("role") || tagName` into `role`, so its candidates arrive as
// role "a" for the links and "nav" for the top bar.
//
// The fixture's a11y tree used to be empty here, which is where the page's name
// comes from: the conversion dropped every subtree under an `ignored` node, and
// Chromium marks `<html>` / `<body>` ignored on every page. Since that fix the
// a11y tier reports these links too (as role `link`), so both tiers emit a
// candidate for the same element. The DOM-walk half is what this keystone pins.
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
    "the DOM-walk fallback contributes its own bare-tag entries",
    async () => {
      await openOn("ks-find-tag-roles-thin");
      const snap = (
        (await handlers["snapshot"]!({ session: "ks-find-tag-roles-thin" })).content[0] as {
          text: string;
        }
      ).text;
      // Both tiers report this fixture: the a11y tier as role `link`, the DOM
      // walk as the bare tag `a`, marked [from-dom].
      expect(snap).toMatch(/a "past".*\[from-dom\]/);
      expect(snap).toContain('link "past"');
      expect(snap).toContain('"tier":"mixed"');
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

      // The bare-tag candidates are the DOM walk's — the a11y tier resolves the
      // same elements to `link` / `navigation`, so pick by role, not position.
      // Position would be arbitrary between the two: both tiers now report the
      // same `data-testid`, because the a11y tier attaches test attributes at
      // all (its `DOM.getAttributes` sweep used to fail on every node).
      const link = found.candidates.find((c) => c.testId === "past" && c.role === "a");
      const navBar = found.candidates.find(
        (c) => c.testId === "top-navigation-bar" && c.role === "nav",
      );

      // DOM-walk-sourced: the bare tag, never the resolved ARIA role.
      expect(link, "a bare-tag `a` candidate for past").toBeTruthy();
      expect(navBar, "a bare-tag `nav` candidate for the navigation bar").toBeTruthy();

      // Container demotion on a bare `nav` is pinned deterministically in the
      // `rankByVisibility` unit tests. It is not asserted here: the phrase
      // ranker scores the exact-named link above the nav on this fixture
      // anyway, so a score comparison would prove nothing about demotion.

      // That the +2 interactive bonus fires on a bare-tag `<a>` is pinned as a
      // delta in the `scoreNode` unit tests; an absolute here would only re-bake
      // the whole scoring formula into a browser test.
      expect(link!.score).toBeGreaterThan(0);
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
