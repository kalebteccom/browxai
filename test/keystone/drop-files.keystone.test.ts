// drop_files keystone — drives the in-page DataTransfer + drag-drop
// synthesis against a real headless Chromium. The fixture's
// `[data-testid="drop-zone"]` div listens for `dragenter`/`dragover`/
// `drop`, reads `event.dataTransfer.files`, and renders the file count,
// MIME types, sizes, and the first 8 bytes of file[0] (as base64) into a
// `[data-testid="drop-log"]` output. The keystone reads it back via
// `verify_text` to prove the bytes actually crossed the Node→page
// boundary and reached the page's drop handler.
//
// The unit suite proves Node-side arg handling and the page-side script's
// event sequence in a jsdom-shaped fake. This keystone is the real-
// browser contract: every Chromium DataTransfer / File / DragEvent quirk
// covered for real.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
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
  workspace = mkdtempSync(join(tmpdir(), "browx-drop-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // file-io is off by default — opt in here so the keystone can call
  // drop_files at all. Capability config is read at server-create time.
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

describe("drop_files keystone — synthesized HTML5 drop reaches DOM handlers with bytes intact", () => {
  it(
    "contents-mode → one file → drop-zone receives a File with correct name/type/size and bytes",
    async () => {
      const session = "ks-drop-contents";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // 5-byte payload "HELLO" (0x48 0x45 0x4C 0x4C 0x4F)
      const payload = Buffer.from("HELLO");
      const r = await callJson<{
        ok: boolean;
        fileCount: number;
        totalBytes: number;
        eventsFired: string[];
        dropDispatched: boolean;
        tokensEstimate: number;
      }>("drop_files", {
        session,
        selector: '[data-testid="drop-zone"]',
        files: [{ contents: payload.toString("base64"), name: "hi.txt", mimeType: "text/plain" }],
      });
      expect(r.ok).toBe(true);
      expect(r.fileCount).toBe(1);
      expect(r.totalBytes).toBe(5);
      expect(r.eventsFired).toEqual(["dragenter", "dragover", "drop"]);
      expect(r.dropDispatched).toBe(true);
      expect(r.tokensEstimate).toBeGreaterThan(0);

      // Read the fixture's drop-log to prove the page-side handler saw
      // the File with the right name/type/size and the first 8 bytes
      // match what we sent.
      const log = await callText("snapshot", { session });
      expect(log).toMatch(/count=1/);
      expect(log).toMatch(/files=hi\.txt:text\/plain:5/);
      // base64("HELLO") = "SEVMTE8="
      expect(log).toMatch(/head8=SEVMTE8=/);
      // "Files" is the type listeners gate on; must be present in
      // dataTransfer.types for React-DnD-style apps to accept the drop.
      expect(log).toMatch(/types=[^ ]*Files/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "path-mode → reads from $BROWX_WORKSPACE → bytes arrive in page",
    async () => {
      const session = "ks-drop-path";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      // Stage bytes inside the workspace; the path-mode reader resolves
      // there. PDF magic bytes (0x25 0x50 0x44 0x46) — easy to verify.
      const stagedPath = join(workspace, "doc.pdf");
      writeFileSync(
        stagedPath,
        Buffer.from([0x25, 0x50, 0x44, 0x46, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]),
      );

      const r = await callJson<{ ok: boolean; fileCount: number; totalBytes: number }>(
        "drop_files",
        {
          session,
          selector: '[data-testid="drop-zone"]',
          files: [{ path: "doc.pdf", mimeType: "application/pdf" }],
        },
      );
      expect(r.ok).toBe(true);
      expect(r.fileCount).toBe(1);
      expect(r.totalBytes).toBe(9);

      const log = await callText("snapshot", { session });
      expect(log).toMatch(/count=1/);
      expect(log).toMatch(/files=doc\.pdf:application\/pdf:9/);
      // base64(0x25 0x50 0x44 0x46 0xaa 0xbb 0xcc 0xdd) = "JVBERqq7zN0="
      expect(log).toMatch(/head8=JVBERqq7zN0=/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "multi-file: drop two files in one event → page sees both in DataTransfer.files",
    async () => {
      const session = "ks-drop-multi";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      const r = await callJson<{ ok: boolean; fileCount: number; totalBytes: number }>(
        "drop_files",
        {
          session,
          selector: '[data-testid="drop-zone"]',
          files: [
            {
              contents: Buffer.from("abc").toString("base64"),
              name: "a.txt",
              mimeType: "text/plain",
            },
            {
              contents: Buffer.from("hi").toString("base64"),
              name: "b.bin",
              mimeType: "application/octet-stream",
            },
          ],
        },
      );
      expect(r.ok).toBe(true);
      expect(r.fileCount).toBe(2);
      expect(r.totalBytes).toBe(5); // 3 + 2

      const log = await callText("snapshot", { session });
      expect(log).toMatch(/count=2/);
      expect(log).toMatch(/files=a\.txt:text\/plain:3\|b\.bin:application\/octet-stream:2/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "workspace escape on path → tool rejects, no drop event fires",
    async () => {
      const session = "ks-drop-escape";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });

      const r = await callJson<{ ok: boolean; error?: string }>("drop_files", {
        session,
        selector: '[data-testid="drop-zone"]',
        files: [{ path: "../../etc/passwd" }],
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/inside \$BROWX_WORKSPACE/);

      // The drop-zone log should still read "undropped" — the rejection
      // landed before any in-page dispatch.
      const log = await callText("snapshot", { session });
      expect(log).toMatch(/undropped/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
