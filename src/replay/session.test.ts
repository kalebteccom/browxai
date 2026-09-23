// Unit-level coverage for ReplaySession — the pieces that DON'T need a real
// browser (truncation, secret masking, artifact linking). The end-to-end
// "record a real Chromium session" gate lives in test/keystone/replay-record.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReplaySession } from "./session.js";
import { readArtifact } from "./artifact.js";
import { SecretRegistry } from "../util/secrets.js";
import { BACKPRESSURE_DROP_KEY } from "./log.js";
import type { Workspace } from "../util/workspace.js";
import type { SessionEntry } from "../session/registry.js";
import type { SourceContext } from "./sources.js";

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

describe("ReplaySession", () => {
  let ws: { workspace: Workspace; dispose: () => void };
  beforeEach(() => {
    ws = tempWorkspace();
  });
  afterEach(() => ws.dispose());

  it("writes a .browx artifact containing the recorded action stream", async () => {
    const s = new ReplaySession(stubEntry());
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

  it("masks registered secrets in WS frame payloads via the ONE chokepoint", async () => {
    // The RFC calls this out specifically: a stream that echoes an auth blob
    // the client sent is the same disclosure as the POST that sent it, so
    // WS/SSE frames go through the same registered-secret mask as HTTP
    // bodies. Drive the frame source adapter directly (a real WS handshake
    // is a keystone concern, not a unit one) and prove the mask ran.
    const secrets = new SecretRegistry();
    const SECRET = "auth-blob-9e28f";
    secrets.register({ name: "AUTHBLOB", value: SECRET });
    const s = new ReplaySession(stubEntry({ secrets }));
    await s.start({ tier: "replay" }, ws.workspace);
    // The orchestrator uses the redactor's `payload` path for every frame;
    // drive the same sources.ts helper the CDP tap calls, with the live
    // context the orchestrator built.
    const src = (s as unknown as { ctx: SourceContext }).ctx;
    const rlog = (s as unknown as { replayLog: { append: (ev: unknown) => boolean } }).replayLog;
    const { wsFrameEvent } = await import("./sources.js");
    rlog.append(
      wsFrameEvent(src, {
        url: "wss://a.test/s",
        dir: "recv",
        kind: "ws",
        payload: `{"token":"${SECRET}"}`,
      }),
    );
    const end = await s.end(ws.workspace);
    const art = await readArtifact(ws.workspace.root, end.path);
    const stringified = JSON.stringify(art.events);
    expect(stringified.includes(SECRET)).toBe(false);
    expect(stringified.includes("<AUTHBLOB>")).toBe(true);
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

  it("reports event-cap truncation independently", async () => {
    const s = new ReplaySession(stubEntry());
    await s.start({ tier: "actions", eventCap: 3 }, ws.workspace);
    for (let i = 0; i < 10; i++) s.noteCall("navigate", { url: `https://a.test/${i}` });
    const end = await s.end(ws.workspace);
    expect(end.truncated?.reason).toBe("event-cap");
    expect(end.events).toBe(3);
  });

  it("records a completed artifact's path for later export_session_report", async () => {
    const s = new ReplaySession(stubEntry());
    expect(s.lastArtifact()).toBeUndefined();
    await s.start({ tier: "actions" }, ws.workspace);
    s.noteCall("navigate", { url: "https://a.test/" });
    const end = await s.end(ws.workspace);
    const last = s.lastArtifact();
    expect(last?.absolutePath).toBe(end.absolutePath);
    expect(last?.path).toBe(end.path);
  });

  it("refuses a second start on the same session while a recording is active", async () => {
    const s = new ReplaySession(stubEntry());
    await s.start({ tier: "actions" }, ws.workspace);
    await expect(s.start({ tier: "actions" }, ws.workspace)).rejects.toThrow(/already active/);
  });

  it("backpressure does not stop capture and is reported in counts", async () => {
    // Prove the pipeline for backpressure the RFC's schema names as load-bearing:
    // 1500 tiny appends with default caps stay well under maxPendingBytes, so
    // no drop fires — the artifact ships un-truncated. The ReplayLog unit
    // tests exercise the pending-window cap directly (an artifact-level test
    // would need a stalled disk, which vitest cannot simulate hermetically).
    const s = new ReplaySession(stubEntry());
    await s.start({ tier: "actions" }, ws.workspace);
    for (let i = 0; i < 1500; i++) s.noteCall("navigate", { url: `https://a.test/${i}` });
    const end = await s.end(ws.workspace);
    expect(end.truncated).toBeUndefined();
    expect(end.counts["action/call"]).toBe(1500);
    expect(end.counts[BACKPRESSURE_DROP_KEY] ?? 0).toBe(0);
  });
});
