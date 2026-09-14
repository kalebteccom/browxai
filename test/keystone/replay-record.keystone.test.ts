// Replay end-to-end keystone. Drives the in-process server against real headless
// Chromium, records a session through the MCP tool surface, and opens the
// resulting `.browx` artifact — the whole pipeline that RFC 0007 phase 3
// integrates. This gates the wiring nothing else does: `start_recording({replay})`
// → real capture → `.browx` → `readArtifact` round-trip.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";
import { readArtifact } from "../../src/replay/artifact.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 180_000;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-replay-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,replay";
  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("replay end-to-end", () => {
  it(
    "records a real session, writes a .browx, opens it back",
    async () => {
      const session = "ks-replay";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      const started = await callJson<{
        ok: boolean;
        name: string;
        replay?: { path: string; tier: string; sessionId: string };
      }>("start_recording", { session, flowName: "keystone-replay", replay: { tier: "replay" } });
      expect(started.ok).toBe(true);
      expect(started.replay?.tier).toBe("replay");
      expect(started.replay?.sessionId).toBe(session);

      // Drive a handful of tool calls to give the log real events on multiple
      // sources: navigation → lifecycle; fill → action/call+result;
      // text_search → action/call+result (read-side).
      await callJson("fill", {
        session,
        selector: '[data-testid="task-input"]',
        value: "hello",
      });
      await callJson("text_search", { session, query: "Keystone Fixture" });
      await callJson("record_annotate", {
        session,
        copy: "search returned matches",
        label: "AC-1",
      });

      const ended = await callJson<{
        ok?: boolean;
        stepCount: number;
        replay?: {
          path: string;
          absolutePath: string;
          bytes: number;
          events: number;
          counts: Record<string, number>;
        };
      }>("end_recording", { session });
      expect(ended.replay).toBeDefined();
      const r = ended.replay!;
      expect(r.bytes).toBeGreaterThan(0);
      // The dispatch wrapper emitted an action/call + action/result per tool
      // call between start_recording and end_recording (fill, text_search).
      // record_annotate is skipped in the dispatch bookend on purpose, and its
      // handler emits an annotate/span directly.
      expect(r.counts["action/call"] ?? 0).toBeGreaterThanOrEqual(2);
      expect(r.counts["action/result"] ?? 0).toBeGreaterThanOrEqual(1);
      expect(r.counts["annotate/span"] ?? 0).toBeGreaterThanOrEqual(1);
      // DOM stream: rrweb emits at least one full snapshot plus incremental
      // events for the fill.
      expect(r.counts["dom/rrweb"] ?? 0).toBeGreaterThan(0);

      const stat = statSync(r.absolutePath);
      expect(stat.size).toBe(r.bytes);

      const art = await readArtifact(workspace, r.path);
      expect(art.manifest.sessionId).toBe(session);
      expect(art.manifest.tier).toBe("replay");
      expect(art.manifest.eventsDigest).toMatch(/^[0-9a-f]{64}$/);
      const types = new Set(art.events.map((e) => e.type));
      expect(types.has("action/call")).toBe(true);
      expect(types.has("dom/rrweb")).toBe(true);
      expect(types.has("annotate/span")).toBe(true);

      // export_session_report links the completed artifact.
      const report = await callJson<{
        replayArtifact?: { path: string; absolutePath: string };
      }>("export_session_report", { session });
      expect(report.replayArtifact?.path).toBe(r.path);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
