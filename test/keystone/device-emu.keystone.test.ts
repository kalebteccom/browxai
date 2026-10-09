// device-emulation keystone: without the off-by-default `device-emulation`
// capability, the four tools (emulate_bluetooth, emulate_usb, emulate_hid,
// device_requests) are rejected at the gate layer.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

// Capability-off gate proof. Run on a separate server with the capability
// stripped — the four tools refuse with the standard structured error.
describe("device-emulation keystone — capability off → tools refuse at the gate", () => {
  let gatedServer: Awaited<ReturnType<typeof createServer>> | undefined;
  let gatedHandlers: Handlers;
  const gatedEnv: Record<string, string | undefined> = {};
  let gatedWorkspace: string | undefined;

  beforeAll(async () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("BROWX_")) {
        gatedEnv[k] = process.env[k];
        delete process.env[k];
      }
    }
    gatedWorkspace = mkdtempSync(join(tmpdir(), "browx-devemu-gated-"));
    process.env.BROWX_WORKSPACE = gatedWorkspace;
    // Default capability set — `device-emulation` deliberately absent.
    process.env.BROWX_CAPABILITIES = "read,navigation,action,human";
    gatedServer = await createServer({ headless: true });
    gatedHandlers = gatedServer.handlers;
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await gatedServer?.shutdown().catch(() => undefined);
    delete process.env.BROWX_WORKSPACE;
    delete process.env.BROWX_CAPABILITIES;
    for (const [k, v] of Object.entries(gatedEnv)) if (v !== undefined) process.env[k] = v;
    if (gatedWorkspace) rmSync(gatedWorkspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "emulate_bluetooth / emulate_usb / emulate_hid / device_requests refuse without the capability",
    async () => {
      for (const tool of ["emulate_bluetooth", "emulate_usb", "emulate_hid", "device_requests"]) {
        const fn = gatedHandlers[tool];
        expect(fn, `${tool} should still be registered`).toBeTruthy();
        const res = await fn!({ devices: [] });
        const body = JSON.parse((res.content[0] as { text: string }).text) as {
          ok: boolean;
          error?: string;
        };
        expect(body.ok, `${tool} should refuse without device-emulation capability`).toBe(false);
        expect(body.error ?? "").toMatch(/capability/i);
      }
    },
    KEYSTONE_TIMEOUT,
  );
});
