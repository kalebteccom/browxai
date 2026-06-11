// Diagnostics keystone — round-trip exercise of the surface.
//
// Drives the in-process server (no browser launched — every tool used here is
// a pure registry/diagnostics primitive) end-to-end:
//
//   1. enable the diagnostics capability via BROWX_CAPABILITIES
//   2. dispatch a handful of tool calls (list_sessions + capability denials)
//   3. file a diagnostics_note
//   4. diagnostics_report({format:"summary"}) returns sensible counts
//   5. diagnostics_search({tool:"list_sessions"}) returns the matching rows
//
// Distinct from the headless keystone: that one needs a real Chrome; this
// one is in-process registry-only so it adds no extra browser-launch cost
// to `pnpm test:keystone`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

const KEYSTONE_TIMEOUT = 30_000;

type ServerHandle = Awaited<ReturnType<typeof createServer>>;
type Handlers = ServerHandle["handlers"];
let server: ServerHandle;
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
  workspace = mkdtempSync(join(tmpdir(), "browx-diag-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // enable the diagnostics capability on top of the defaults
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,diagnostics";
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("diagnostics round-trip", () => {
  it(
    "records calls + notes, then diagnostics_report surfaces sensible counts",
    async () => {
      // (1) Dispatch a handful of zero-browser calls — each lands as a
      // JSONL `kind:"call"` record in the workspace diagnostics dir.
      await callJson<{ ok: boolean }>("list_sessions", {});
      await callJson<{ ok: boolean }>("list_sessions", {});
      // (2) Drive a capability denial — try a tool whose capability is
      // OFF (eval_js). The denial must land as a `capability-denied`
      // failureKind on the recorder.
      const denied = await callJson<{ ok: boolean; requiredCapability?: string }>("eval_js", {
        expr: "1+1",
      });
      expect(denied.ok).toBe(false);
      expect(denied.requiredCapability).toBe("eval");

      // (3) File one note via diagnostics_note.
      const noteResp = await callJson<{ ok: boolean }>("diagnostics_note", {
        insight: "would like a primitive that returns innerText of a ref without an eval_js",
        category: "missing-primitive",
        severity: "warn",
      });
      expect(noteResp.ok).toBe(true);

      // (4) diagnostics_report({format:"summary"}) — counts must reflect
      // the calls + note we just made.
      const summary = await callJson<{
        ok: boolean;
        summary: {
          perTool: Record<string, { count: number; failureCount: number }>;
          capabilityDenials: Record<string, number>;
          notesByCategory: Record<string, number>;
        };
      }>("diagnostics_report", {});
      expect(summary.ok).toBe(true);
      expect(summary.summary.perTool.list_sessions?.count).toBeGreaterThanOrEqual(2);
      expect(summary.summary.perTool.eval_js?.failureCount).toBeGreaterThanOrEqual(1);
      expect(summary.summary.capabilityDenials.eval_js).toBeGreaterThanOrEqual(1);
      expect(summary.summary.notesByCategory["missing-primitive"]).toBe(1);

      // (5) diagnostics_search({tool:"list_sessions"}) — surfaces only the
      // matching call records.
      const search = await callJson<{
        ok: boolean;
        records: Array<{ kind: string; tool?: string }>;
        count: number;
      }>("diagnostics_search", { tool: "list_sessions" });
      expect(search.ok).toBe(true);
      expect(search.count).toBeGreaterThanOrEqual(2);
      for (const r of search.records) {
        expect(r.kind).toBe("call");
        expect(r.tool).toBe("list_sessions");
      }

      // (6) full-format report must include the per-record stream.
      const full = await callJson<{
        ok: boolean;
        records?: Array<{ kind: string }>;
        truncated?: boolean;
      }>("diagnostics_report", { format: "full" });
      expect(full.ok).toBe(true);
      expect(Array.isArray(full.records)).toBe(true);
      expect(full.records!.length).toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );
});
