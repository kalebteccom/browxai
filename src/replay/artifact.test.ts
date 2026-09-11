import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  ArtifactIntegrityError,
  AssetStore,
  EVENTS_ENTRY,
  MANIFEST_ENTRY,
  parseEventLog,
  readArtifact,
  sha256,
  writeArtifact,
  zipBuild,
  zipRead,
} from "./artifact.js";
import { ReplayLog, readEventLog } from "./log.js";
import { REPLAY_ARTIFACT_EXT, REPLAY_SCHEMA_VERSION, type ReplayManifest } from "./schema.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "browx-replay-artifact-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function manifest(over: Partial<ReplayManifest> = {}): Omit<ReplayManifest, "eventsDigest"> {
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    sessionId: "s-1",
    clockOrigin: 1_700_000_000_000,
    tier: "replay",
    browxaiVersion: "0.10.0",
    engine: "chromium",
    counts: {},
    ...over,
  };
}

function jsonl(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("AssetStore — content addressing and dedup", () => {
  it("addresses by sha256 and returns the same key for the same bytes", () => {
    const store = new AssetStore();
    const a = store.add("body { color: red }");
    const b = store.add(Buffer.from("body { color: red }", "utf8"));
    expect(a).toBe(b);
    expect(a).toBe(sha256(Buffer.from("body { color: red }", "utf8")));
  });

  it("stores one copy of a bundle an SPA reloads on every navigation", () => {
    const store = new AssetStore();
    const bundle = Buffer.alloc(1024 * 1024, 7);
    for (let i = 0; i < 10; i++) store.add(bundle);

    expect(store.added).toBe(10);
    expect(store.distinct).toBe(1);
    expect(store.storedBytes).toBe(1024 * 1024);
    expect(store.savedBytes).toBe(9 * 1024 * 1024);
  });

  it("keeps distinct bytes distinct", () => {
    const store = new AssetStore();
    store.add("one");
    store.add("two");
    store.add("one");
    expect(store.distinct).toBe(2);
    expect(store.added).toBe(3);
  });

  it("returns the stored bytes by hash, and undefined for an unknown hash", () => {
    const store = new AssetStore();
    const key = store.add("payload");
    expect(store.get(key)?.toString("utf8")).toBe("payload");
    expect(store.get("0".repeat(64))).toBeUndefined();
  });

  it("copies on store, so a mutated caller buffer cannot corrupt the artifact", () => {
    const store = new AssetStore();
    const buf = Buffer.from("original");
    const key = store.add(buf);
    buf.write("MUTATED!");
    expect(store.get(key)?.toString("utf8")).toBe("original");
  });
});

describe("writeArtifact / readArtifact", () => {
  it("round-trips the manifest, events, assets, screenshots and video", async () => {
    const store = new AssetStore();
    const jsKey = store.add("console.log(1)");
    const cssKey = store.add("a{}");
    const events = jsonl(
      {
        t: 0,
        type: "action/call",
        v: 1,
        payload: { tool: "navigate", args: { url: "https://x" } },
      },
      { t: 12, type: "action/result", v: 1, payload: { tool: "navigate", ok: true } },
    );

    const written = await writeArtifact({
      workspaceRoot: root,
      path: "replays/s-1.browx",
      manifest: manifest({ counts: { "action/call": 1, "action/result": 1 } }),
      events,
      assets: store,
      screenshots: [Buffer.from("webp-0"), Buffer.from("webp-1")],
      video: Buffer.from("webm-bytes"),
    });

    expect(written.path).toBe(join(root, "replays/s-1.browx"));
    expect(written.eventsDigest).toBe(sha256(Buffer.from(events, "utf8")));

    const art = await readArtifact(root, "replays/s-1.browx");
    expect(art.manifest.sessionId).toBe("s-1");
    expect(art.manifest.counts).toEqual({ "action/call": 1, "action/result": 1 });
    expect(art.events).toHaveLength(2);
    expect(art.events[1]?.payload).toEqual({ tool: "navigate", ok: true });
    expect(art.assets.size).toBe(2);
    expect(Buffer.from(art.assets.get(jsKey) ?? []).toString("utf8")).toBe("console.log(1)");
    expect(Buffer.from(art.assets.get(cssKey) ?? []).toString("utf8")).toBe("a{}");
    expect(art.screenshots.map((s) => Buffer.from(s).toString("utf8"))).toEqual([
      "webp-0",
      "webp-1",
    ]);
    expect(Buffer.from(art.video ?? []).toString("utf8")).toBe("webm-bytes");
  });

  it("appends the .browx extension when the caller omits it", async () => {
    const written = await writeArtifact({
      workspaceRoot: root,
      path: "replays/no-ext",
      manifest: manifest(),
      events: jsonl({ t: 0, type: "a", v: 1, payload: {} }),
    });
    expect(written.path.endsWith(REPLAY_ARTIFACT_EXT)).toBe(true);
    await expect(readArtifact(root, "replays/no-ext.browx")).resolves.toBeDefined();
  });

  it("rejects a path that escapes the workspace root", async () => {
    await expect(
      writeArtifact({
        workspaceRoot: root,
        path: "../escape.browx",
        manifest: manifest(),
        events: "",
      }),
    ).rejects.toThrow(/must resolve inside \$BROWX_WORKSPACE/);
    await expect(readArtifact(root, "../escape.browx")).rejects.toThrow(
      /must resolve inside \$BROWX_WORKSPACE/,
    );
  });

  it("omits video and screenshots when none were captured", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "bare.browx",
      manifest: manifest({ tier: "actions" }),
      events: jsonl({ t: 0, type: "console/message", v: 1, payload: { text: "x" } }),
    });
    const art = await readArtifact(root, "bare.browx");
    expect(art.video).toBeUndefined();
    expect(art.screenshots).toEqual([]);
    expect(art.assets.size).toBe(0);
  });

  it("carries the truncation flag through to the reader", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "cut.browx",
      manifest: manifest({ truncated: { at: 900, reason: "size-cap", droppedEvents: 41 } }),
      events: jsonl({ t: 0, type: "a", v: 1, payload: {} }),
    });
    const art = await readArtifact(root, "cut.browx");
    expect(art.manifest.truncated).toEqual({ at: 900, reason: "size-cap", droppedEvents: 41 });
  });
});

describe("dedup across the container", () => {
  it("writes one assets/ entry for a bundle added ten times", async () => {
    const store = new AssetStore();
    const bundle = Buffer.alloc(256 * 1024, 3);
    const other = Buffer.alloc(1024, 9);
    for (let i = 0; i < 10; i++) store.add(bundle);
    store.add(other);

    const written = await writeArtifact({
      workspaceRoot: root,
      path: "dedup.browx",
      manifest: manifest({ tier: "reexecutable" }),
      events: jsonl({ t: 0, type: "net/response", v: 1, payload: {} }),
      assets: store,
    });

    // manifest + events + 2 assets
    expect(written.entries).toBe(4);
    const art = await readArtifact(root, "dedup.browx");
    expect(art.assets.size).toBe(2);
    expect(art.assets.get(sha256(bundle))?.byteLength).toBe(256 * 1024);

    // The dedup claim in bytes: 11 adds totalling ~2.6MB land as ~257KB.
    expect(store.added).toBe(11);
    expect(store.storedBytes).toBe(256 * 1024 + 1024);
    expect(store.savedBytes).toBe(9 * 256 * 1024);
  });
});

describe("integrity", () => {
  it("verifies eventsDigest against the pre-compression bytes", async () => {
    const events = jsonl({ t: 0, type: "a", v: 1, payload: { n: 1 } });
    const written = await writeArtifact({
      workspaceRoot: root,
      path: "ok.browx",
      manifest: manifest(),
      events,
    });
    const art = await readArtifact(root, "ok.browx");
    expect(art.manifest.eventsDigest).toBe(sha256(Buffer.from(events, "utf8")));
    expect(written.eventsDigest).toBe(art.manifest.eventsDigest);
  });

  it("refuses an artifact whose manifest digest does not match the log", async () => {
    const events = jsonl({ t: 0, type: "a", v: 1, payload: {} });
    await writeArtifact({ workspaceRoot: root, path: "bad.browx", manifest: manifest(), events });

    // A structurally perfect container — correct zip, correct CRCs — whose
    // manifest claims a digest the log does not hash to. Only the digest check
    // catches this, which is the point of having it.
    const abs = join(root, "bad.browx");
    const files = zipRead(readFileSync(abs));
    const patched = {
      ...(JSON.parse(files.get(MANIFEST_ENTRY)?.toString("utf8") ?? "{}") as ReplayManifest),
      eventsDigest: "f".repeat(64),
    };
    writeFileSync(
      abs,
      zipBuild([
        { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(patched), "utf8") },
        { name: EVENTS_ENTRY, data: files.get(EVENTS_ENTRY) ?? Buffer.alloc(0) },
      ]),
    );

    await expect(readArtifact(root, "bad.browx")).rejects.toThrow(ArtifactIntegrityError);
    await expect(readArtifact(root, "bad.browx")).rejects.toThrow(/digest mismatch/);
  });

  it("refuses an artifact whose event log was swapped for a different one", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "a.browx",
      manifest: manifest(),
      events: jsonl({ t: 0, type: "a", v: 1, payload: { real: true } }),
    });
    await writeArtifact({
      workspaceRoot: root,
      path: "b.browx",
      manifest: manifest(),
      events: jsonl({ t: 0, type: "a", v: 1, payload: { forged: true } }),
    });
    const a = zipRead(readFileSync(join(root, "a.browx")));
    const b = zipRead(readFileSync(join(root, "b.browx")));
    writeFileSync(
      join(root, "a.browx"),
      zipBuild([
        { name: MANIFEST_ENTRY, data: a.get(MANIFEST_ENTRY) ?? Buffer.alloc(0) },
        { name: EVENTS_ENTRY, data: b.get(EVENTS_ENTRY) ?? Buffer.alloc(0) },
      ]),
    );
    await expect(readArtifact(root, "a.browx")).rejects.toThrow(/digest mismatch/);
  });

  it("refuses a container with no manifest", async () => {
    writeFileSync(
      join(root, "nomanifest.browx"),
      zipBuild([{ name: EVENTS_ENTRY, data: Buffer.from("x") }]),
    );
    await expect(readArtifact(root, "nomanifest.browx")).rejects.toThrow(/missing manifest\.json/);
  });

  it("refuses a container with no event log", async () => {
    writeFileSync(
      join(root, "nolog.browx"),
      zipBuild([
        {
          name: MANIFEST_ENTRY,
          data: Buffer.from(JSON.stringify({ ...manifest(), eventsDigest: "0" })),
        },
      ]),
    );
    await expect(readArtifact(root, "nolog.browx")).rejects.toThrow(/missing events\.jsonl/);
  });

  it("refuses a file that is not a zip", async () => {
    writeFileSync(join(root, "junk.browx"), "definitely not a zip");
    await expect(readArtifact(root, "junk.browx")).rejects.toThrow(ArtifactIntegrityError);
    await expect(readArtifact(root, "junk.browx")).rejects.toThrow(/no end-of-central-directory/);
  });

  it("refuses a container with a flipped byte inside an entry", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "flip.browx",
      manifest: manifest(),
      events: jsonl(
        ...Array.from({ length: 40 }, (_, i) => ({ t: i, type: "a", v: 1, payload: { i } })),
      ),
    });
    const abs = join(root, "flip.browx");
    const buf = readFileSync(abs);
    // Corrupt inside the first entry's body, past the local header + name.
    const at = 30 + MANIFEST_ENTRY.length + 4;
    buf[at] = (buf[at] ?? 0) ^ 0xff;
    writeFileSync(abs, buf);

    await expect(readArtifact(root, "flip.browx")).rejects.toThrow(ArtifactIntegrityError);
    await expect(readArtifact(root, "flip.browx")).rejects.toThrow(
      /CRC mismatch|failed to decompress|corrupt/,
    );
  });
});

describe("forward compatibility", () => {
  const futureLog = jsonl(
    { t: 0, type: "action/call", v: 1, payload: { tool: "click", args: {} } },
    {
      t: 40,
      type: "quantum/entangle",
      v: 7,
      payload: { qubits: 2, nested: { spin: ["up", "down"] } },
      targetId: "T9",
      provenance: "a 2027 recorder",
    },
    {
      t: 80,
      type: "action/result",
      v: 1,
      payload: { tool: "click", ok: true, futurePayloadField: { latencyBudgetMs: 12 } },
    },
  );

  it("passes through an unknown event type instead of dropping or failing", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "future.browx",
      manifest: manifest({ counts: { "quantum/entangle": 1 } }),
      events: futureLog,
    });
    const art = await readArtifact(root, "future.browx");

    expect(art.events).toHaveLength(3);
    const future = art.events[1];
    expect(future?.type).toBe("quantum/entangle");
    expect(future?.t).toBe(40);
    expect(future?.v).toBe(7);
    expect(future?.payload).toEqual({ qubits: 2, nested: { spin: ["up", "down"] } });
    expect(future?.targetId).toBe("T9");
  });

  it("preserves unknown envelope fields verbatim", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "future.browx",
      manifest: manifest(),
      events: futureLog,
    });
    const art = await readArtifact(root, "future.browx");
    expect(art.events[1]).toHaveProperty("provenance", "a 2027 recorder");
  });

  it("preserves unknown payload fields on a KNOWN event type", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "future.browx",
      manifest: manifest(),
      events: futureLog,
    });
    const art = await readArtifact(root, "future.browx");
    expect(art.events[2]?.payload).toEqual({
      tool: "click",
      ok: true,
      futurePayloadField: { latencyBudgetMs: 12 },
    });
  });

  it("opens a log written against a newer schema version", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "v99.browx",
      manifest: { ...manifest({ tier: "reexecutable" }), schemaVersion: 99 },
      events: futureLog,
    });
    const art = await readArtifact(root, "v99.browx");
    expect(art.manifest.schemaVersion).toBe(99);
    expect(art.events).toHaveLength(3);
  });

  it("keeps unknown manifest fields", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "extra.browx",
      manifest: { ...manifest(), futureManifestField: "kept" } as Omit<
        ReplayManifest,
        "eventsDigest"
      >,
      events: futureLog,
    });
    const art = await readArtifact(root, "extra.browx");
    expect(art.manifest).toHaveProperty("futureManifestField", "kept");
  });

  it("ignores unrecognised container entries without failing to open", async () => {
    const events = jsonl({ t: 0, type: "a", v: 1, payload: {} });
    const store = new AssetStore();
    store.add("x");
    await writeArtifact({
      workspaceRoot: root,
      path: "roomy.browx",
      manifest: manifest(),
      events,
      assets: store,
    });
    const art = await readArtifact(root, "roomy.browx");
    expect(art.events).toHaveLength(1);
    expect(art.assets.size).toBe(1);
  });
});

describe("parseEventLog", () => {
  it("skips blank lines", () => {
    const out = parseEventLog('\n{"t":0,"type":"a","v":1,"payload":{}}\n\n');
    expect(out.events).toHaveLength(1);
    expect(out.malformed).toEqual([]);
  });

  it("quarantines an unparseable line rather than throwing", () => {
    const out = parseEventLog('{"t":0,"type":"a","v":1,"payload":{}}\n{broken\n');
    expect(out.events).toHaveLength(1);
    expect(out.malformed).toEqual(["{broken"]);
  });

  it("quarantines a line that is valid JSON but not an object", () => {
    const out = parseEventLog("42\n[1,2]\n");
    expect(out.events).toEqual([]);
    expect(out.malformed).toEqual(["42", "[1,2]"]);
  });

  it("defaults a missing envelope field instead of rejecting the event", () => {
    const out = parseEventLog('{"type":"legacy/thing","payload":{"a":1}}\n');
    expect(out.events[0]).toMatchObject({ t: 0, type: "legacy/thing", v: 0, payload: { a: 1 } });
  });
});

// The point of these two is that a THIRD-PARTY zip implementation accepts what
// the hand-rolled writer produces. Skipped where `unzip` is absent rather than
// failing the gate on a missing system tool.
const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasUnzip)("the container is a real zip", () => {
  it("unzip -l lists the expected entries", async () => {
    const store = new AssetStore();
    store.add("asset-bytes");
    await writeArtifact({
      workspaceRoot: root,
      path: "real.browx",
      manifest: manifest(),
      events: jsonl({ t: 0, type: "a", v: 1, payload: {} }),
      assets: store,
      screenshots: [Buffer.from("shot")],
    });
    const listing = execFileSync("unzip", ["-l", join(root, "real.browx")], { encoding: "utf8" });
    expect(listing).toContain(MANIFEST_ENTRY);
    expect(listing).toContain(EVENTS_ENTRY);
    expect(listing).toContain("screenshots/0.webp");
    expect(listing).toContain("assets/");
  });

  it("unzip -t reports no errors", async () => {
    await writeArtifact({
      workspaceRoot: root,
      path: "real.browx",
      manifest: manifest(),
      events: jsonl(
        ...Array.from({ length: 200 }, (_, i) => ({ t: i, type: "n", v: 1, payload: { i } })),
      ),
    });
    const out = execFileSync("unzip", ["-t", join(root, "real.browx")], { encoding: "utf8" });
    expect(out).toContain("No errors detected");
  });
});

describe("compression", () => {
  it("compresses the event log — the .browx is smaller than the raw jsonl", async () => {
    const events = jsonl(
      ...Array.from({ length: 2000 }, (_, i) => ({
        t: i,
        type: "net/request",
        v: 1,
        payload: { url: "https://example.test/api/items", method: "GET", i },
      })),
    );
    const written = await writeArtifact({
      workspaceRoot: root,
      path: "small.browx",
      manifest: manifest(),
      events,
    });
    expect(written.bytes).toBeLessThan(Buffer.byteLength(events, "utf8") / 4);
  });
});

describe("log to artifact, end to end", () => {
  it("captures with ReplayLog and seals the result into a readable .browx", async () => {
    let clock = 0;
    const log = await ReplayLog.open({
      workspaceRoot: root,
      path: "work/s-7/events.jsonl",
      clockOrigin: 1_700_000_000_000,
      now: () => clock,
    });
    log.record("action/call", { tool: "navigate", args: { url: "https://app.test" } });
    clock = 10;
    log.record("dom/rrweb", { type: 2, data: { node: {} } });
    clock = 20;
    log.record("future/panel-only", { anything: true }, { v: 3 });
    const stats = await log.close();

    const store = new AssetStore();
    for (let i = 0; i < 5; i++) store.add("the-same-bundle");

    const written = await writeArtifact({
      workspaceRoot: root,
      path: "replays/s-7.browx",
      manifest: manifest({
        sessionId: "s-7",
        clockOrigin: stats.clockOrigin,
        counts: stats.counts,
        ...(stats.truncated ? { truncated: stats.truncated } : {}),
      }),
      events: await readEventLog(root, "work/s-7/events.jsonl"),
      assets: store,
    });

    const art = await readArtifact(root, "replays/s-7.browx");
    expect(art.manifest.clockOrigin).toBe(1_700_000_000_000);
    expect(art.manifest.counts).toEqual({
      "action/call": 1,
      "dom/rrweb": 1,
      "future/panel-only": 1,
    });
    expect(art.events.map((e) => e.t)).toEqual([0, 10, 20]);
    expect(art.events[2]?.type).toBe("future/panel-only");
    expect(art.assets.size).toBe(1);
    expect(written.entries).toBe(3);
    expect(art.malformed).toEqual([]);
  });
});

describe("the zip layer", () => {
  it("round-trips entries byte for byte", () => {
    const entries = [
      { name: "a.txt", data: Buffer.from("hello") },
      { name: "nested/b.bin", data: Buffer.from([0, 255, 1, 254, 0, 0, 7]) },
      { name: "empty", data: Buffer.alloc(0) },
      { name: "unicode-Ünïcödé.txt", data: Buffer.from("ñ ü é 漢字", "utf8") },
    ];
    const out = zipRead(zipBuild(entries));
    expect([...out.keys()]).toEqual(entries.map((e) => e.name));
    for (const entry of entries) {
      expect(Buffer.from(out.get(entry.name) ?? []).equals(Buffer.from(entry.data))).toBe(true);
    }
  });

  it("stores rather than deflates when deflate would not shrink the entry", () => {
    const incompressible = randomBytes(4096);
    const zip = zipBuild([{ name: "r.bin", data: incompressible }]);
    expect(zip.readUInt16LE(8)).toBe(0);
    expect(Buffer.from(zipRead(zip).get("r.bin") ?? []).equals(incompressible)).toBe(true);
  });

  it("deflates an entry that compresses", () => {
    const zip = zipBuild([{ name: "c.txt", data: Buffer.alloc(8192, 0x61) }]);
    expect(zip.readUInt16LE(8)).toBe(8);
    expect(zip.byteLength).toBeLessThan(1000);
  });

  it("is deterministic — the same entries produce identical bytes", () => {
    const entries = [{ name: "x", data: Buffer.from("same") }];
    expect(zipBuild(entries).equals(zipBuild(entries))).toBe(true);
  });

  it("round-trips a large entry", () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x2a);
    const out = zipRead(zipBuild([{ name: "big", data: big }]));
    expect(out.get("big")?.byteLength).toBe(big.byteLength);
  });
});
