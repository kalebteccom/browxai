// Direct instrumentation of screenshotMarks's resolveCandidates path on
// example.com. Bypasses the MCP handler so we can probe per-call timing.

import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
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
  process.env.BROWX_WORKSPACE = mkdtempSync(join(tmpdir(), "browx-trace-"));
  server = await createServer({ headless: true });
  handlers = server.handlers;
  await call("set_config", { scope: "project", patch: { actionTimeoutMs: 90_000 } });
}, 60_000);

afterAll(async () => {
  if (!SKIP) await server?.shutdown().catch(() => undefined);
}, 60_000);

describe.skipIf(SKIP)("screenshot_marks trace", () => {
  it("example.com — direct call instrumentation", async () => {
    const session = "trace";
    await call("open_session", { session, mode: "incognito" });
    await call("navigate", { session, url: "https://example.com/" });

    // Reach into the server internals — the session registry lives on a handler.
    // Use list_sessions to get the session id, then access via the internal
    // entry-for path. Cleanest: open + use the screenshot_marks handler with
    // tracing instead. We monkey-patch screenshotMarks by re-implementing the
    // resolve loop with timing.
    const snap = await call<string>("snapshot", { session });
    const refs = Array.from(
      new Set(Array.from(snap.matchAll(/\[ref=(e\d+)\]/g)).map((m) => m[1]!)),
    );

    console.log("refs", refs);

    // We can't easily reach the Page/CDPSession from a registered handler at
    // this layer. The MCP perf-probe already established the symptom — keep
    // this trace minimal and just measure handler timing under controlled load.
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      const r = await call<Record<string, unknown>>("screenshot_marks", {
        session,
        candidates: [{ ref: refs[0]! }],
        label: "index",
      });

      console.log(`iter${i} bare-ref ${Date.now() - t}ms keys=`, Object.keys(r));
    }
    for (let i = 0; i < 2; i++) {
      const t = Date.now();
      const r = await call<Record<string, unknown>>("screenshot_marks", {
        session,
        candidates: [{ ref: refs[0]!, bbox: { x: 50, y: 50, width: 100, height: 50 } }],
        label: "index",
      });

      console.log(`iter${i} fast-path ${Date.now() - t}ms keys=`, Object.keys(r));
    }

    await call("close_session", { session });
  }, 600_000);
});
