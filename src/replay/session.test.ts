// Unit-level coverage for ReplaySession — the pieces that DON'T need a real
// browser (truncation, secret masking, artifact linking). The end-to-end
// "record a real Chromium session" gate lives in test/keystone/replay-record.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gunzipSync } from "node:zlib";

import { ReplaySession } from "./session.js";
import { readArtifact, zipRead } from "./artifact.js";
import { SecretRegistry } from "../util/secrets.js";
import type { Workspace } from "../util/workspace.js";
import type { SessionEntry } from "../session/registry.js";

/** Minimal SessionEntry stand-in — the orchestrator only reads `id`, `secrets`,
 *  and `session.engine`/`session.cdp?()`/`session.page()`. Anything else stays
 *  undefined here on purpose so the constructor never accidentally couples to
 *  the full role bundle. */
function stubEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  const session = {
    engine: "chromium" as const,
    // page() throws → the DOM/network attach path early-exits, matching the
    // Safari-engine short-circuit in ReplaySession.attachSources.
    page: () => {
      throw new Error("no page in unit test");
    },
    close: async () => undefined,
    mode: "incognito" as const,
    ownsBrowser: true,
  };
  return {
    id: "s1",
    secrets: new SecretRegistry(),
    session,
    ...overrides,
  } as unknown as SessionEntry;
}

function tempWorkspace(): { workspace: Workspace; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "browx-replay-session-"));
  const workspace: Workspace = {
    root,
    sub(name: string): string {
      const p = join(root, name);
      return p;
    },
    defaultProfile: () => join(root, "profile"),
  };
  return { workspace, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** Assert `value` is in no byte of the archive: not in the file as written, and
 *  not in any entry once the zip layer and the gzip layer are taken off. */
function expectNowhereInArchive(absolutePath: string, value: string): void {
  const needle = Buffer.from(value, "utf8");
  const archive = readFileSync(absolutePath);
  expect(archive.includes(needle), "the archive file").toBe(false);
  const entries = zipRead(archive);
  expect(entries.size).toBeGreaterThan(0);
  for (const [name, data] of entries) {
    expect(data.includes(needle), `entry ${name}`).toBe(false);
    if (name.endsWith(".gz")) {
      expect(gunzipSync(data).includes(needle), `entry ${name}, decompressed`).toBe(false);
    }
  }
}

describe("ReplaySession", () => {
  let ws: { workspace: Workspace; dispose: () => void };
  beforeEach(() => {
    ws = tempWorkspace();
  });
  afterEach(() => ws.dispose());

  it("writes a .browx artifact containing the recorded action stream", async () => {
    const s = new ReplaySession(stubEntry());
    expect(s.lastArtifact()).toBeUndefined();
    const start = await s.start({ tier: "actions" }, ws.workspace);
    expect(start.tier).toBe("actions");

    s.noteCall("navigate", { url: "https://example.test/" });
    s.noteResult("navigate", { ok: true });
    s.noteCall("verify_visible", { ref: "e1" });
    s.noteResult("verify_visible", {
      ok: false,
      failure: { kind: "not-visible", expected: true, actual: false },
    });
    s.annotate({ label: "AC-1", copy: "search returns results" });

    const end = await s.end(ws.workspace);
    expect(end.bytes).toBeGreaterThan(0);
    expect(end.events).toBe(5);
    expect(end.path).toContain(".browx");
    // The finished artifact's path is what export_session_report reads later.
    expect(s.lastArtifact()?.absolutePath).toBe(end.absolutePath);
    expect(s.lastArtifact()?.path).toBe(end.path);

    const art = await readArtifact(ws.workspace.root, end.path);
    expect(art.manifest.tier).toBe("actions");
    expect(art.manifest.sessionId).toBe("s1");
    expect(art.manifest.eventsDigest).toMatch(/^[0-9a-f]{64}$/);
    const types = art.events.map((e) => e.type);
    expect(types).toEqual([
      "action/call",
      "action/result",
      "action/call",
      // A verify_* result with the structured failure becomes an assertion.
      "assert/result",
      "annotate/span",
    ]);
    const anno = art.events[4] as unknown as {
      payload: { label: string; phase: string; note?: string };
    };
    expect(anno.payload.label).toBe("AC-1");
    expect(anno.payload.phase).toBe("start");
  });

  it("does not write a registered secret into the artifact bytes", async () => {
    const secrets = new SecretRegistry();
    const SECRET = "super-secret-hunter2-value";
    secrets.register({ name: "PASSWORD", value: SECRET });
    const s = new ReplaySession(stubEntry({ secrets }));
    await s.start({ tier: "actions" }, ws.workspace);
    // Every entry point (call args, result payload, annotation) must run
    // through applyMaskDeep. Prove all three by feeding the secret at each.
    s.noteCall("fill", { value: SECRET, ref: "e1" });
    s.noteResult("fill", { ok: true, error: `wrote ${SECRET}` });
    s.annotate({ label: "AC-1", note: `note: ${SECRET}` });
    const end = await s.end(ws.workspace);
    const bytes = readFileSync(end.absolutePath);
    // Bytes-level: the secret must not appear anywhere in the archive — not
    // in the plaintext manifest, not in the (gzip-compressed) event log, not
    // in the zip metadata. gzip'd substrings do not survive as literal bytes,
    // so a literal-byte scan on the whole archive is the right rung of proof.
    expect(bytes.includes(Buffer.from(SECRET, "utf8"))).toBe(false);
    // Events-level: after decompression, every occurrence of the value has
    // become the `<PASSWORD>` alias — call args, result error, annotation
    // note.
    const art = await readArtifact(ws.workspace.root, end.path);
    const stringified = JSON.stringify(art.events);
    expect(stringified.includes(SECRET)).toBe(false);
    expect(stringified.includes("<PASSWORD>")).toBe(true);
  });

  it("keeps a register_secret value out of the archive when the value is then typed", async () => {
    const secrets = new SecretRegistry();
    const SECRET = "typed-after-register-hunter2";
    const s = new ReplaySession(stubEntry({ secrets }));
    await s.start({ tier: "actions" }, ws.workspace);
    // The order the dispatch wrapper runs in: action/call is emitted first,
    // then the handler registers the value, then the result is emitted.
    s.noteCall("register_secret", { name: "PASSWORD", value: SECRET });
    secrets.register({ name: "PASSWORD", value: SECRET });
    s.noteResult("register_secret", { ok: true });
    s.noteCall("fill", { ref: "e1", value: SECRET });
    s.noteResult("fill", { ok: true, element: { value: SECRET } });
    const end = await s.end(ws.workspace);

    expectNowhereInArchive(end.absolutePath, SECRET);
    const art = await readArtifact(ws.workspace.root, end.path);
    expect(JSON.stringify(art.events)).not.toContain(SECRET);
    const calls = art.events.filter((e) => e.type === "action/call").map((e) => e.payload);
    expect(calls).toEqual([
      {
        tool: "register_secret",
        args: { name: "PASSWORD", value: { redacted: true, reason: "secret" } },
      },
      { tool: "fill", args: { ref: "e1", value: "<PASSWORD>" } },
    ]);
  });

  it("keeps the value of a refused register_secret out of the archive", async () => {
    // The name is not a valid alias, so the handler registers nothing and no
    // later mask pass can know the value.
    const SECRET = "never-registered-hunter2";
    const s = new ReplaySession(stubEntry());
    await s.start({ tier: "actions" }, ws.workspace);
    s.noteCall("register_secret", { name: "not valid", value: SECRET });
    s.noteResult("register_secret", { ok: false, error: "register_secret: name must match" });
    s.noteCall("batch", {
      calls: [{ tool: "register_secret", args: { name: "PASSWORD", value: SECRET } }],
    });
    s.noteResult("batch", { ok: false });
    const end = await s.end(ws.workspace);
    expectNowhereInArchive(end.absolutePath, SECRET);
  });

  it("masks a value registered after the events that hold it", async () => {
    const secrets = new SecretRegistry();
    const SECRET = "shown-then-registered-hunter2";
    const s = new ReplaySession(stubEntry({ secrets }));
    await s.start({ tier: "actions" }, ws.workspace);
    // A page shows a token. The agent reads it and only then registers it.
    s.noteCall("eval_js", { expr: `document.title === "${SECRET}"` });
    s.noteResult("eval_js", { ok: false, error: `page shows ${SECRET}` });
    s.annotate({ label: "AC-2", note: `token on screen: ${SECRET}` });
    s.noteCall("register_secret", { name: "TOKEN", value: SECRET });
    secrets.register({ name: "TOKEN", value: SECRET });
    s.noteResult("register_secret", { ok: true });
    const end = await s.end(ws.workspace);

    expectNowhereInArchive(end.absolutePath, SECRET);
    // The digest in the manifest is of the masked log, so the archive opens.
    const art = await readArtifact(ws.workspace.root, end.path);
    expect(art.malformed).toEqual([]);
    expect(art.events).toHaveLength(end.events);
    const stringified = JSON.stringify(art.events);
    expect(stringified).not.toContain(SECRET);
    expect(art.events[0]?.payload).toEqual({
      tool: "eval_js",
      args: { expr: 'document.title === "<TOKEN>"' },
    });
    expect(art.events[1]?.payload).toMatchObject({ error: "page shows <TOKEN>" });
    expect(art.events[2]?.payload).toMatchObject({ note: "token on screen: <TOKEN>" });
  });

  it("masks registered secrets deeper than the bounded applyMaskDeep cap", async () => {
    // rrweb's DOM stream serialises as `{childNodes:[{childNodes:[...]}]}` —
    // roughly two JS levels per DOM level. The bounded `applyMaskDeep` cap (8
    // levels) stops masking at ~three DOM levels down, so a token buried in a
    // routine six-level page landed on disk in cleartext. This regression pins
    // the fix: registered secrets are stripped at ARBITRARY nesting depth via
    // the full-depth mask that `Redactor.mask` now calls.
    const secrets = new SecretRegistry();
    const SECRET = "deep-secret-value-hunter2";
    secrets.register({ name: "PASSWORD", value: SECRET });
    const s = new ReplaySession(stubEntry({ secrets }));
    await s.start({ tier: "actions" }, ws.workspace);

    // Build a nested tree 20 JS levels deep — well past the bounded cap and
    // well past any real DOM depth.
    interface Node {
      childNodes: Node[];
      text?: string;
    }
    const leaf: Node = { childNodes: [], text: `token:${SECRET}` };
    let node: Node = leaf;
    for (let i = 0; i < 20; i++) node = { childNodes: [node] };

    s.noteCall("navigate", { url: "https://a.test/", tree: node });
    const end = await s.end(ws.workspace);
    const art = await readArtifact(ws.workspace.root, end.path);
    const stringified = JSON.stringify(art.events);
    expect(stringified.includes(SECRET)).toBe(false);
    expect(stringified.includes("<PASSWORD>")).toBe(true);
  });

  it("reports size-cap truncation on manifest without stopping the recording", async () => {
    const s = new ReplaySession(stubEntry());
    await s.start({ tier: "actions", sizeCap: 512 }, ws.workspace);
    // Each action/call is ~60 bytes serialised — 20 will overflow 512.
    for (let i = 0; i < 20; i++) s.noteCall("navigate", { url: `https://a.test/${i}` });
    const end = await s.end(ws.workspace);
    expect(end.truncated?.reason).toBe("size-cap");
    expect(end.truncated?.droppedEvents).toBeGreaterThan(0);
    const art = await readArtifact(ws.workspace.root, end.path);
    expect(art.manifest.truncated?.reason).toBe("size-cap");
  });

  it("refuses a second start on the same session while a recording is active", async () => {
    const s = new ReplaySession(stubEntry());
    await s.start({ tier: "actions" }, ws.workspace);
    await expect(s.start({ tier: "actions" }, ws.workspace)).rejects.toThrow(/already active/);
  });
});
