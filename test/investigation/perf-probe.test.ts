// Isolated wall-clock probe for screenshot_marks on example.com.
// Tries to localise the unexpectedly-slow bare-ref first-call seen in the
// main investigation suite (~60s on a page that snapshot reads in 6ms).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

const SKIP = process.env.WRX_NO_NET === "1";
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Awaited<ReturnType<typeof createServer>>["handlers"];

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

beforeAll(async () => {
  if (SKIP) return;
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  const ws = mkdtempSync(join(tmpdir(), "browx-perf-"));
  process.env.BROWX_WORKSPACE = ws;
  server = await createServer({ headless: true });
  handlers = server.handlers;
  await call("set_config", { scope: "project", patch: { actionTimeoutMs: 90_000 } });
}, 60_000);

afterAll(async () => {
  if (SKIP) return;
  await server?.shutdown().catch(() => undefined);
}, 60_000);

describe.skipIf(SKIP)("screenshot_marks perf probe", () => {
  it("example.com — back-to-back calls show whether first-call cost is startup or per-call", async () => {
    const session = "perf";
    await call("open_session", { session, mode: "incognito" });
    await call("navigate", { session, url: "https://example.com/" });

    const t0 = Date.now();
    const snap = await call<string>("snapshot", { session });
    const tSnap = Date.now() - t0;
    const refs = Array.from(
      new Set(Array.from(snap.matchAll(/\[ref=(e\d+)\]/g)).map((m) => m[1]!)),
    );

    console.log(`tSnap=${tSnap}ms refs=`, refs);

    // Plain screenshot (warm path).
    const t1 = Date.now();
    await call("screenshot", { session });
    const tShot = Date.now() - t1;
    console.log(`tShot=${tShot}ms`);

    // First marks call (bare-ref).
    const t2 = Date.now();
    const m1 = await call<Record<string, unknown>>("screenshot_marks", {
      session,
      candidates: refs.slice(0, 2).map((r) => ({ ref: r })),
      label: "index",
    });
    const tM1 = Date.now() - t2;
    console.log(`tM1=${tM1}ms keys=`, Object.keys(m1));

    // Second marks call (bare-ref).
    const t3 = Date.now();
    const m2 = await call<Record<string, unknown>>("screenshot_marks", {
      session,
      candidates: refs.slice(0, 2).map((r) => ({ ref: r })),
      label: "index",
    });
    const tM2 = Date.now() - t3;
    console.log(`tM2=${tM2}ms keys=`, Object.keys(m2));

    // Third marks call with full-candidate fast-path.
    const t4 = Date.now();
    const m3 = await call<Record<string, unknown>>("screenshot_marks", {
      session,
      candidates: refs
        .slice(0, 2)
        .map((r) => ({ ref: r, bbox: { x: 100, y: 100, width: 80, height: 30 } })),
      label: "index",
    });
    const tM3 = Date.now() - t4;
    console.log(`tM3=${tM3}ms keys=`, Object.keys(m3));

    expect(tShot).toBeLessThan(5000);
    // Don't assert tM1 — that's what we want to observe.
    await call("close_session", { session });
  }, 240_000);
});
