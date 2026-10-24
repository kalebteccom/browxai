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
    expect(future).toHaveProperty("provenance", "a 2027 recorder");
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
});

describe("parseEventLog", () => {
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

// The point of this one is that a THIRD-PARTY zip implementation accepts what
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
});
