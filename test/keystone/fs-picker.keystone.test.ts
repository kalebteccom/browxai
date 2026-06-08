// fs-picker keystone — drive a real headless Chromium against the fixture's
// showSaveFilePicker handler, exercise each policy mode end-to-end.
//
// `fs_picker_respond` is gated on the off-by-default `file-io` capability
// (workspace-rooted egress on the createWritable() write target). The gate
// is resolved ONCE at server start, so we spin up our own server here with
// the capability enabled — same pattern as the page-archive keystone.
//
// What this proves end-to-end (a real headless Chrome, no mocks below
// the tool layer):
//   - DEFAULT raise: a page calling `showSaveFilePicker` does NOT deadlock
//     (the contract). The picker promise rejects with NotAllowedError; the
//     ActionResult surfaces `fsPickerRequests:[{api,handledAs:"raised"}]`.
//   - allow + fs_picker_respond: the page receives a synthetic
//     FileSystemFileHandle; createWritable() → write() → close() persists
//     to the agent-supplied workspace-rooted path.
//   - deny: NotAllowedError + handledAs:"denied".

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

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
  if (!fn) throw new Error(`fs-picker keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handlers[name]!(args);
  return (res.content[0] as { text: string }).text;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-fspicker-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  // Enable `file-io` for the lifetime of this server — fs_picker_respond's gate.
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,file-io";

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

describe("fs-picker keystone — showSaveFilePicker against real Chromium", () => {
  it(
    "default raise rejects, allow+respond writes to workspace, deny rejects with NotAllowedError",
    async () => {
      const session = "ks-fspicker";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // (1) DEFAULT raise — the click triggers showSaveFilePicker which the
      // stub rejects; the result surfaces fsPickerRequests with handledAs:
      // "raised". The page never deadlocks; it sees NotAllowedError.
      const clickRaised = await callJson<{
        ok: boolean;
        fsPickerRequests?: Array<{ api: string; handledAs: string; suggestedName?: string }>;
      }>("click", { session, selector: '[data-testid="save-btn-fs"]' });
      expect(Array.isArray(clickRaised.fsPickerRequests)).toBe(true);
      const raisedReq = clickRaised.fsPickerRequests!.find((r) => r.api === "showSaveFilePicker");
      expect(raisedReq, "save-picker request recorded under raise mode").toBeTruthy();
      expect(raisedReq!.handledAs).toBe("raised");
      expect(raisedReq!.suggestedName).toBe("keystone.txt");
      // The page promise resolves to a picker-error; poll until the output
      // transitions.
      let raisedText = "";
      for (let i = 0; i < 30 && !raisedText.includes("picker-error"); i++) {
        raisedText = await callText("snapshot", { session });
        if (raisedText.includes("picker-error")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(raisedText).toMatch(/picker-error name=NotAllowedError/);

      // (2) Flip to allow + stage a workspace-rooted destination.
      const setPol = await callJson<{ ok: boolean; policy: { mode: string } }>(
        "set_fs_picker_policy",
        { session, mode: "allow" },
      );
      expect(setPol.ok).toBe(true);
      expect(setPol.policy.mode).toBe("allow");
      const respond = await callJson<{ ok: boolean; queued: { api: string; fileCount: number } }>(
        "fs_picker_respond",
        { session, api: "showSaveFilePicker", files: [{ path: "ks-fspicker-out.txt" }] },
      );
      expect(respond.ok).toBe(true);
      expect(respond.queued.fileCount).toBe(1);

      const clickAllowed = await callJson<{
        ok: boolean;
        fsPickerRequests?: Array<{ api: string; handledAs: string }>;
      }>("click", { session, selector: '[data-testid="save-btn-fs"]' });
      const allowReq = (clickAllowed.fsPickerRequests ?? []).find((r) => r.api === "showSaveFilePicker");
      expect(allowReq, "save-picker request recorded under allow mode").toBeTruthy();
      expect(allowReq!.handledAs).toBe("allowed");

      // Poll until the page reports the write completed. The page calls
      // createWritable() → write(payload) → close() which round-trips
      // through the binding; needs a beat for the bytes to land on disk.
      let allowText = "";
      for (let i = 0; i < 60 && !allowText.includes("wrote name="); i++) {
        allowText = await callText("snapshot", { session });
        if (allowText.includes("wrote name=")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(allowText).toMatch(/wrote name=ks-fspicker-out\.txt bytes=\d+/);

      // The bytes the page wrote actually landed at the workspace path.
      const persisted = join(workspace, "ks-fspicker-out.txt");
      expect(existsSync(persisted), "workspace file persisted").toBe(true);
      expect(readFileSync(persisted, "utf8")).toMatch(/^keystone-payload-\d+$/);

      // (3) Flip to deny + re-trigger; the stub throws NotAllowedError.
      await callJson("set_fs_picker_policy", { session, mode: "deny" });
      const clickDenied = await callJson<{
        ok: boolean;
        fsPickerRequests?: Array<{ api: string; handledAs: string }>;
      }>("click", { session, selector: '[data-testid="save-btn-fs"]' });
      const denyReq = (clickDenied.fsPickerRequests ?? []).find((r) => r.api === "showSaveFilePicker");
      expect(denyReq, "save-picker request recorded under deny mode").toBeTruthy();
      expect(denyReq!.handledAs).toBe("denied");
      let denyText = "";
      for (let i = 0; i < 30 && !denyText.includes("picker-error"); i++) {
        denyText = await callText("snapshot", { session });
        if (denyText.includes("picker-error")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(denyText).toMatch(/picker-error name=NotAllowedError/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "workspace escape on fs_picker_respond is rejected at the tool layer",
    async () => {
      const session = "ks-fspicker-escape";
      await callJson("open_session", { session, mode: "incognito" });
      const respond = await callJson<{ ok: boolean; error?: string }>(
        "fs_picker_respond",
        { session, api: "showSaveFilePicker", files: [{ path: "../escape.txt" }] },
      );
      expect(respond.ok).toBe(false);
      expect(respond.error).toMatch(/inside \$BROWX_WORKSPACE/);
      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
