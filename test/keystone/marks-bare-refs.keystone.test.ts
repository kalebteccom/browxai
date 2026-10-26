// screenshot_marks bare-ref keystone — real headless Chromium against
// `/marks-page`.
//
// A bare `{ref}` candidate carries no box, so `screenshot_marks` has to find
// one. It used to look the ref up in a fresh composed-tree walk and fall back to
// a role/name selector built from that node, one ref at a time. A DOM-walk ref
// (bare tag role, no accessible name) had no selector that matched, and ten refs
// in sequence each waited out their own locator timeout, so the call overran the
// tool deadline and returned an error with no marks at all.
//
// The box now comes from the ref table, through the same locator a click
// resolves the ref with, and the bare refs resolve in parallel. Only a real page
// proves it: the refs are minted by a real `snapshot`, the boxes are the live
// layout's, and the deadline is the real one.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;
/** The tool's default action deadline (`actionTimeoutMs`), inlined. */
const ACTION_DEADLINE_MS = 5000;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Mark {
  index: number;
  ref: string;
  role?: string;
  name?: string;
  testId?: string;
  bbox: Box | null;
  painted: boolean;
}

interface MarksResult {
  ok?: boolean;
  error?: string;
  marks: Mark[];
  mapping: Record<string, string>;
  warnings: string[];
}

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
const savedEnv: Record<string, string | undefined> = {};

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`marks keystone: no handler "${name}"`);
  const res = await fn(args);
  return (res.content[0] as { text: string }).text;
}

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return JSON.parse(await callText(name, args)) as T;
}

function refOf(line: string): string {
  const ref = /\[ref=(e\d+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`no ref on line: ${line}`);
  return ref;
}

async function openOn(session: string): Promise<void> {
  const opened = await callJson<{ ok: boolean }>("open_session", { session, mode: "incognito" });
  expect(opened.ok).toBe(true);
  const nav = await callJson<{ ok: boolean }>("navigate", {
    session,
    url: `${fixture.url}/marks-page`,
  });
  expect(nav.ok).toBe(true);
}

/** The fixture's ten elements as `{elementId → ref}`, read off a real snapshot. */
async function mintRefs(session: string): Promise<Map<string, string>> {
  const snap = await callText("snapshot", { session });
  const lines = snap.split("\n").filter((l) => l.includes("[ref="));
  const out = new Map<string, string>();
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]) {
    const line = lines.find((l) => l.includes(`button "${name}"`));
    expect(line, `no button "${name}" line in snapshot:\n${snap}`).toBeDefined();
    out.set(`mark-btn-${name.toLowerCase()}`, refOf(line!));
  }
  for (const n of [1, 2, 3, 4]) {
    const line = lines.find((l) => l.includes(`"mark-tile-${n}"`));
    expect(line, `no mark-tile-${n} line in snapshot:\n${snap}`).toBeDefined();
    // Nameless tiles reach the snapshot only through the DOM walk.
    expect(line).toContain("[from-dom]");
    out.set(`mark-tile-${n}`, refOf(line!));
  }
  expect(new Set(out.values()).size).toBe(10);
  return out;
}

/** The live layout's rect for each element id, read in the page. */
async function liveRects(session: string, ids: string[]): Promise<Record<string, Box>> {
  const res = await callJson<{ ok: boolean; value: Record<string, Box> }>("eval_js", {
    session,
    expr: `(() => {
      const out = {};
      for (const id of ${JSON.stringify(ids)}) {
        const r = document.getElementById(id).getBoundingClientRect();
        out[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      return out;
    })()`,
  });
  expect(res.ok).toBe(true);
  return res.value;
}

function expectBoxNear(actual: Box, expected: Box, label: string): void {
  for (const k of ["x", "y", "width", "height"] as const) {
    expect(
      Math.abs(actual[k] - expected[k]),
      `${label}.${k}: painted ${actual[k]}, live ${expected[k]}`,
    ).toBeLessThanOrEqual(1);
  }
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  // eval reads the live rects the painted boxes are checked against;
  // screenshot_marks and snapshot ride `read`.
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,eval";

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

describe("screenshot_marks keystone — bare refs resolve through the ref table", () => {
  it(
    "paints ten bare snapshot refs with their live boxes inside the deadline",
    async () => {
      const session = "ks-marks-ten";
      await openOn(session);
      const refs = await mintRefs(session);
      const ids = [...refs.keys()];

      const started = Date.now();
      const res = await callJson<MarksResult>("screenshot_marks", {
        session,
        candidates: ids.map((id) => ({ ref: refs.get(id)! })),
      });
      const elapsed = Date.now() - started;

      // A deadline overrun comes back as `{ok:false, error}` with no marks.
      expect(res.ok, `screenshot_marks failed: ${res.error}`).toBeUndefined();
      expect(elapsed).toBeLessThan(ACTION_DEADLINE_MS);
      expect(res.marks).toHaveLength(10);

      const live = await liveRects(session, ids);
      ids.forEach((id, i) => {
        const mark = res.marks[i]!;
        expect(mark.index).toBe(i + 1);
        expect(mark.ref).toBe(refs.get(id));
        expect(mark.bbox, `${id} (${mark.ref}) has no box`).not.toBeNull();
        expect(mark.painted).toBe(true);
        expectBoxNear(mark.bbox!, live[id]!, id);
        expect(res.mapping[String(i + 1)]).toBe(refs.get(id));
      });

      // The four DOM-only tiles are the fixture's fixed 60x24.
      for (const id of ids.filter((x) => x.startsWith("mark-tile-"))) {
        const mark = res.marks.find((m) => m.ref === refs.get(id))!;
        expect(Math.round(mark.bbox!.width)).toBe(60);
        expect(Math.round(mark.bbox!.height)).toBe(24);
      }

      // None of the ten known refs is reported as unresolved.
      for (const ref of refs.values()) {
        expect(res.warnings.filter((w) => w.includes(`"${ref}"`))).toEqual([]);
      }

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "names a ref the table has never seen in warnings and paints the rest",
    async () => {
      const session = "ks-marks-unknown";
      await openOn(session);
      const refs = await mintRefs(session);
      const known = refs.get("mark-tile-1")!;
      const unknown = "e99999";
      expect([...refs.values()]).not.toContain(unknown);

      const res = await callJson<MarksResult>("screenshot_marks", {
        session,
        candidates: [{ ref: known }, { ref: unknown }],
      });
      expect(res.ok, `screenshot_marks failed: ${res.error}`).toBeUndefined();
      expect(res.marks).toHaveLength(2);

      expect(res.marks[0]!.ref).toBe(known);
      expect(res.marks[0]!.painted).toBe(true);
      expect(res.marks[0]!.bbox).not.toBeNull();

      expect(res.marks[1]!.ref).toBe(unknown);
      expect(res.marks[1]!.bbox).toBeNull();
      expect(res.marks[1]!.painted).toBe(false);

      const named = res.warnings.filter((w) => w.includes(`"${unknown}"`));
      expect(named, `warnings: ${JSON.stringify(res.warnings)}`).toHaveLength(1);
      expect(named[0]).toContain("not in the ref table");
      expect(res.warnings.some((w) => w.includes(`"${known}"`))).toBe(false);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
