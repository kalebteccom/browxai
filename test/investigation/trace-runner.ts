// Standalone CLI for tracing screenshotMarks on example.com.
// Usage: BROWX_TRACE_MARKS=1 pnpm tsx test/investigation/trace-runner.ts

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

async function call<T>(
  handlers: Record<string, (a: unknown) => Promise<{ content: { text: string }[] }>>,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`no handler "${name}"`);
  const res = await fn(args);
  const text = res.content[0]!.text;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

async function main() {
  for (const k of Object.keys(process.env))
    if (k.startsWith("BROWX_") && k !== "BROWX_TRACE_MARKS") delete process.env[k];
  process.env.BROWX_WORKSPACE = mkdtempSync(join(tmpdir(), "browx-trace-cli-"));
  const server = await createServer({ headless: true });
  const handlers = server.handlers as unknown as Record<
    string,
    (a: unknown) => Promise<{ content: { text: string }[] }>
  >;
  await call(handlers, "set_config", { scope: "project", patch: { actionTimeoutMs: 90_000 } });
  const session = "trace";
  await call(handlers, "open_session", { session, mode: "incognito" });
  await call(handlers, "navigate", { session, url: "https://example.com/" });
  const snap = await call<string>(handlers, "snapshot", { session });
  const refs = Array.from(new Set(Array.from(snap.matchAll(/\[ref=(e\d+)\]/g)).map((m) => m[1]!)));
  console.log(`refs ${JSON.stringify(refs)}`);
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    const r = await call<Record<string, unknown>>(handlers, "screenshot_marks", {
      session,
      candidates: [{ ref: refs[0]! }],
      label: "index",
    });
    console.log(`iter${i} bare ${Date.now() - t}ms keys=${Object.keys(r).join(",")}`);
  }
  await call(handlers, "close_session", { session });
  await server.shutdown().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
