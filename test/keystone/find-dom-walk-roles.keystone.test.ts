// find() tag-vs-ARIA-role keystone — real headless Chromium against the
// table-shaped `/thin-a11y-page` fixture. The DOM-walk fallback writes
// `getAttribute("role") || tagName` into `role`, so its candidates arrive as
// role "a" for the links and "nav" for the top bar.
//
// The fixture's a11y tree used to be empty here, which is where the page's name
// comes from: the conversion dropped every subtree under an `ignored` node, and
// Chromium marks `<html>` / `<body>` ignored on every page. Since that fix the
// a11y tier reports these links too (as role `link`), and the tier merge folds
// the DOM walk's entry into the a11y node, so each link is one candidate under
// its ARIA role. The page's `tabindex` div is what still arrives as the DOM
// walk's own: the a11y tier exposes it as a nameless `generic` the serialiser
// emits no line for, so the merge leaves the entry alone. That is the bare-tag
// half this keystone pins.
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
      // Both tiers report the links, so each is one `[from-both]` line under
      // the a11y tier's ARIA role. The `tabindex` div is the DOM walk's alone —
      // the a11y tier exposes it as a nameless `generic` the serialiser emits
      // no line for — so it keeps its `[from-dom]` line AND its bare tag.
      expect(snap).toMatch(/link "past".*\[from-both\]/);
      expect(snap).not.toMatch(/a "past"/);
      expect(snap).toMatch(/div .*dom-only-widget.*\[from-dom\]/);
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

      // One candidate per element: both tiers see these two, so each arrives
      // once, under the a11y tier's ARIA role.
      const link = found.candidates.find((c) => c.testId === "past");
      const navBar = found.candidates.find((c) => c.testId === "top-navigation-bar");
      expect(link, "a candidate for past").toBeTruthy();
      expect(navBar, "a candidate for the navigation bar").toBeTruthy();
      expect(link!.role).toBe("link");
      expect(navBar!.role).toBe("navigation");
      expect(found.candidates.filter((c) => c.testId === "past")).toHaveLength(1);

      // The DOM walk's own candidate carries the bare tag, never a resolved
      // ARIA role: `role` feeds `elementKey`, so normalising it at the merge
      // would rotate every DOM-sourced ref.
      const domOnly = await callJson<{ candidates: Candidate[] }>("find", {
        session,
        query: "dom-only-widget",
      });
      const widget = domOnly.candidates.find((c) => c.testId === "dom-only-widget");
      expect(widget, "a bare-tag candidate for the DOM-only widget").toBeTruthy();
      expect(widget!.role).toBe("div");

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
