// Replay capability-gate keystone. The `replay` capability is posture-broadening
// (an artifact carries real page content); the standard drill is that a
// posture-broadening surface has a keystone that asserts the gate BLOCKS when
// the capability isn't granted, with a structured `capability-denied` refusal,
// not a silent no-op that would leave a caller thinking a recording is running.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../../src/server.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 60_000;

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
  workspace = mkdtempSync(join(tmpdir(), "browx-replay-gate-"));
  process.env.BROWX_WORKSPACE = workspace;
  // The DEFAULT capability set — no `replay`. This is the point of the gate.
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("replay capability gate", () => {
  it(
    "refuses start_recording({replay}) when `replay` is not in the active set",
    async () => {
      const session = "ks-replay-gate";
      const denied = await callJson<{
        ok: boolean;
        error: string;
        requiredCapability: string;
      }>("start_recording", {
        session,
        flowName: "keystone-replay-gate",
        replay: { tier: "replay" },
      });
      expect(denied.ok).toBe(false);
      // Compound refusal rides the same shape as the primary gate — the
      // classifier keys on `requiredCapability`, not on error-string content.
      expect(denied.requiredCapability).toBe("replay");
      expect(denied.error).toMatch(/capability is not in the server's ACTIVE set/);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "still allows a normal (YAML-only) start_recording",
    async () => {
      const session = "ks-replay-gate-normal";
      const started = await callJson<{
        ok?: boolean;
        name: string;
        replay?: unknown;
      }>("start_recording", { session, flowName: "yaml-only" });
      expect(started.name).toBe("yaml-only");
      expect(started.replay).toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );
});
