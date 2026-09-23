// The `.browx` container (RFC 0007): a zip holding the manifest, the compressed
// event log, content-addressed assets, screenshots and an optional video.
//
// The zip reader/writer is hand-rolled because the alternative is a dependency
// for ~120 lines of stable, 30-year-old format. Store/deflate entries only, no
// zip64, no encryption — everything a `.browx` needs and nothing else.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

import { resolveWorkspaceReadPath, resolveWorkspaceWritePath } from "../util/workspace.js";
import { REPLAY_ARTIFACT_EXT, type ReplayEvent, type ReplayManifest } from "./schema.js";

const TOOL = "replay_artifact";

export const MANIFEST_ENTRY = "manifest.json";
export const EVENTS_ENTRY = "events.jsonl.gz";
export const ASSET_PREFIX = "assets/";
export const SCREENSHOT_PREFIX = "screenshots/";
export const VIDEO_ENTRY = "video.webm";

const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_OFFSET = 0xffffffff;

export class ArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactIntegrityError";
  }
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Content-addressed, deduplicating asset store. An SPA reloads the same bundle
 *  on every navigation; storing by hash is the difference between a 40MB
 *  artifact and a 400MB one. */
export class AssetStore {
  private readonly blobs = new Map<string, Buffer>();
  private addCount = 0;
  private rawBytes = 0;

  add(data: Uint8Array | string): string {
    const view = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const digest = sha256(view);
    this.addCount++;
    this.rawBytes += view.byteLength;
    if (!this.blobs.has(digest)) this.blobs.set(digest, Buffer.from(view));
    return digest;
  }

  get(digest: string): Buffer | undefined {
    return this.blobs.get(digest);
  }

  entries(): IterableIterator<[string, Buffer]> {
    return this.blobs.entries();
  }

  /** Assets actually stored, after dedup. */
  get distinct(): number {
    return this.blobs.size;
  }

  /** Calls to `add`, including the ones that hit an existing hash. */
  get added(): number {
    return this.addCount;
  }

  get storedBytes(): number {
    let total = 0;
    for (const blob of this.blobs.values()) total += blob.byteLength;
    return total;
  }

  get savedBytes(): number {
    return this.rawBytes - this.storedBytes;
  }
}

export interface WriteArtifactInput {
  workspaceRoot: string;
  /** Workspace-relative path. `.browx` is appended when missing. */
  path: string;
  /** `eventsDigest` is computed from `events`, so it is not an input. */
  manifest: Omit<ReplayManifest, "eventsDigest">;
  /** Raw `events.jsonl` bytes, before compression. */
  events: Uint8Array | string;
  assets?: AssetStore;
  screenshots?: readonly Uint8Array[];
  video?: Uint8Array;
}

export interface WriteArtifactResult {
  path: string;
  bytes: number;
  entries: number;
  eventsDigest: string;
}

export interface ReplayArtifact {
  manifest: ReplayManifest;
  events: ReplayEvent[];
  /** Lines that were not parseable JSON, kept verbatim so nothing is lost. */
  malformed: string[];
  assets: Map<string, Uint8Array>;
  screenshots: Uint8Array[];
  video?: Uint8Array;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export async function writeArtifact(input: WriteArtifactInput): Promise<WriteArtifactResult> {
  const events =
    typeof input.events === "string" ? Buffer.from(input.events, "utf8") : input.events;
  const eventsDigest = sha256(events);
  const manifest: ReplayManifest = { ...input.manifest, eventsDigest };

  const entries: ZipEntry[] = [
    { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
    { name: EVENTS_ENTRY, data: gzipSync(events, { level: 9 }) },
  ];
  for (const [digest, blob] of sortedAssets(input.assets)) {
    entries.push({ name: ASSET_PREFIX + digest, data: blob });
  }
  (input.screenshots ?? []).forEach((shot, i) => {
    entries.push({ name: `${SCREENSHOT_PREFIX}${i}.webp`, data: shot });
  });
  if (input.video) entries.push({ name: VIDEO_ENTRY, data: input.video });

  const name = input.path.endsWith(REPLAY_ARTIFACT_EXT)
    ? input.path
    : input.path + REPLAY_ARTIFACT_EXT;
  const abs = resolveWorkspaceWritePath(input.workspaceRoot, name, TOOL);
  // `abs` is inside $BROWX_WORKSPACE by construction — resolveWorkspacePath
  // throws on anything that escapes the root, so both writes below are rooted.
  await mkdir(dirname(abs), { recursive: true });
  const zip = zipBuild(entries);
  await writeFile(abs, zip);
  return { path: abs, bytes: zip.byteLength, entries: entries.length, eventsDigest };
}

export async function readArtifact(workspaceRoot: string, path: string): Promise<ReplayArtifact> {
  const abs = resolveWorkspaceReadPath(workspaceRoot, path, TOOL);
  const files = zipRead(await readFile(abs));

  const manifestRaw = files.get(MANIFEST_ENTRY);
  if (!manifestRaw) throw new ArtifactIntegrityError(`${path}: missing ${MANIFEST_ENTRY}`);
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as ReplayManifest;

  const eventsName = [...files.keys()].find((k) => k.startsWith("events.jsonl"));
  const eventsRaw = eventsName ? files.get(eventsName) : undefined;
  if (!eventsName || !eventsRaw) throw new ArtifactIntegrityError(`${path}: missing events.jsonl`);
  const events = decompressEvents(eventsName, eventsRaw);

  const actual = sha256(events);
  if (actual !== manifest.eventsDigest) {
    throw new ArtifactIntegrityError(
      `${path}: events.jsonl digest mismatch — manifest says ${manifest.eventsDigest}, ` +
        `the log hashes to ${actual}. The artifact is corrupt; refusing to open it.`,
    );
  }

  const assets = new Map<string, Uint8Array>();
  const shots: { index: number; data: Uint8Array }[] = [];
  for (const [entryName, data] of files) {
    if (entryName.startsWith(ASSET_PREFIX)) assets.set(entryName.slice(ASSET_PREFIX.length), data);
    else if (entryName.startsWith(SCREENSHOT_PREFIX)) {
      shots.push({ index: Number.parseInt(entryName.slice(SCREENSHOT_PREFIX.length), 10), data });
    }
  }
  shots.sort((a, b) => a.index - b.index);

  const parsed = parseEventLog(events.toString("utf8"));
  const video = files.get(VIDEO_ENTRY);
  return {
    manifest,
    events: parsed.events,
    malformed: parsed.malformed,
    assets,
    screenshots: shots.map((s) => s.data),
    ...(video ? { video } : {}),
  };
}

/** Forward compatibility, the rule the format rests on: every line that is an
 *  object becomes an event, whatever its `type`, and the parsed record is spread
 *  through so unknown payload AND envelope fields survive verbatim. Nothing is
 *  validated away. */
export function parseEventLog(text: string): { events: ReplayEvent[]; malformed: string[] } {
  const events: ReplayEvent[] = [];
  const malformed: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformed.push(line);
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      malformed.push(line);
      continue;
    }
    const rec = raw as Record<string, unknown>;
    events.push({
      ...rec,
      t: typeof rec.t === "number" ? rec.t : 0,
      type: typeof rec.type === "string" ? rec.type : "unknown",
      v: typeof rec.v === "number" ? rec.v : 0,
      payload: rec.payload,
    });
  }
  return { events, malformed };
}

function sortedAssets(store: AssetStore | undefined): [string, Buffer][] {
  return store ? [...store.entries()].sort((a, b) => a[0].localeCompare(b[0])) : [];
}

function decompressEvents(name: string, data: Buffer): Buffer {
  if (name.endsWith(".gz")) return gunzipSync(data);
  if (name.endsWith(".zst")) {
    throw new ArtifactIntegrityError(
      `replay artifact: ${name} is zstd-compressed, which this build cannot read. ` +
        `browxai writes ${EVENTS_ENTRY}.`,
    );
  }
  return data;
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipBuild(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new Error(`replay artifact: ${entries.length} entries exceeds the zip limit`);
  }
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const deflated = deflateRawSync(raw);
    const stored = deflated.byteLength >= raw.byteLength;
    const body = stored ? raw : deflated;
    const crc = crc32(raw);
    if (offset + 30 + name.length + body.byteLength > ZIP_MAX_OFFSET) {
      throw new Error("replay artifact: exceeds the 4GB zip limit — lower the capture size cap");
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(stored ? 0 : 8, 10);
    dir.writeUInt16LE(0x0021, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.byteLength, 20);
    dir.writeUInt32LE(raw.byteLength, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += 30 + name.length + body.byteLength;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function zipRead(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const files = new Map<string, Buffer>();
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new ArtifactIntegrityError("replay artifact: corrupt zip central directory");
    }
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    const bodyAt =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const body = buf.subarray(bodyAt, bodyAt + compSize);
    let data: Buffer;
    try {
      data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    } catch (err) {
      throw new ArtifactIntegrityError(
        `replay artifact: "${name}" failed to decompress — ${String(err)}`,
      );
    }
    if (crc32(data) !== crc) {
      throw new ArtifactIntegrityError(`replay artifact: CRC mismatch on "${name}"`);
    }
    files.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function findEocd(buf: Buffer): number {
  // The end-of-central-directory record sits in the last 22 bytes plus at most a
  // 64KB comment, so the backward scan is bounded at 65557.
  const floor = Math.max(0, buf.byteLength - 65557);
  for (let i = buf.byteLength - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ArtifactIntegrityError(
    "replay artifact: not a zip — no end-of-central-directory found",
  );
}
