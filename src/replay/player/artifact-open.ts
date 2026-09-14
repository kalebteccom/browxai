// Browser-side reader for the `.browx` container. `../artifact.ts` is the Node
// writer/reader and leans on `node:zlib` + `node:crypto`; this is the same
// format read through Web APIs only (`DecompressionStream`, `crypto.subtle`,
// `TextDecoder`), so it runs from `file://` with no server and no bundled
// inflate library — and still runs under Node, which is what lets the unit
// tests drive it against an artifact `writeArtifact` actually produced.
//
// Everything past the central directory is streamed. A 200MB log is inflated,
// decoded and parsed in chunks with a yield between them, so the main thread
// keeps painting instead of freezing on one synchronous parse.

import type { ReplayEvent, ReplayManifest } from "../schema.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_EOCD_SCAN = 65557;
const DEFLATE = 8;

/** Above this the log is streamed but not hashed: `crypto.subtle.digest` has no
 *  incremental form, so verifying would mean holding a second full copy of the
 *  decoded log. Comfortably above `DEFAULT_MAX_BYTES` in `../log.ts`, so an
 *  artifact browxai actually wrote is always verified. */
export const DIGEST_VERIFY_LIMIT = 96 * 1024 * 1024;

/** Work budget between yields. Long enough that the per-yield overhead is
 *  noise, short enough that a frame still lands. */
const SLICE_MS = 12;

export class ArtifactOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactOpenError";
  }
}

export interface ZipEntryView {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  bodyOffset: number;
}

export type OpenPhase = "directory" | "manifest" | "events" | "verify" | "done";

export interface OpenProgress {
  phase: OpenPhase;
  /** Uncompressed event bytes decoded so far. */
  bytes: number;
  events: number;
}

export interface OpenArtifactOptions {
  onProgress?: (p: OpenProgress) => void;
  /** Overridable so a test can force the unhashed path without a 256MB fixture. */
  digestLimit?: number;
}

export interface OpenedArtifact {
  manifest: ReplayManifest;
  events: ReplayEvent[];
  /** Lines that were not parseable JSON. Counted, never dropped silently. */
  malformed: number;
  /** `undefined` when the log was too large to hash, or the platform has no
   *  `crypto.subtle` (a `file://` page in a browser that is not a secure
   *  context). A player that cannot verify says so instead of implying it did. */
  digestVerified: boolean | undefined;
  screenshotCount: number;
  asset(digest: string): Promise<Uint8Array | undefined>;
  screenshot(index: number): Promise<Uint8Array | undefined>;
  video(): Promise<Uint8Array | undefined>;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEocd(bytes: Uint8Array): number {
  const dv = view(bytes);
  const floor = Math.max(0, bytes.byteLength - MAX_EOCD_SCAN);
  for (let i = bytes.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new ArtifactOpenError("not a .browx archive — no zip end-of-central-directory record");
}

/** The central directory only. Entry bodies stay untouched on disk until
 *  something asks for them, so opening a 200MB artifact costs one directory
 *  walk, not 200MB of inflate. */
export function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntryView> {
  const dv = view(bytes);
  const eocd = findEocd(bytes);
  const count = dv.getUint16(eocd + 10, true);
  const entries = new Map<string, ZipEntryView>();
  const decoder = new TextDecoder();
  let p = dv.getUint32(eocd + 16, true);

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw new ArtifactOpenError("corrupt zip central directory");
    }
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const bodyOffset =
      localOffset +
      30 +
      dv.getUint16(localOffset + 26, true) +
      dv.getUint16(localOffset + 28, true);
    entries.set(name, { name, method, compressedSize, size, bodyOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** `DecompressionStream` is typed `BufferSource` in, `Uint8Array` out, which
 *  does not unify with a `ReadableStream<Uint8Array>` pipe. The cast is the
 *  whole disagreement: the values are already byte chunks. */
function decompress(
  stream: ReadableStream<Uint8Array>,
  format: "gzip" | "deflate-raw",
): ReadableStream<Uint8Array> {
  const pair = new DecompressionStream(format) as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return stream.pipeThrough(pair);
}

function chunkStream(chunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Raw body bytes of one entry, inflated if the entry was deflated. */
export function entryStream(bytes: Uint8Array, entry: ZipEntryView): ReadableStream<Uint8Array> {
  const body = bytes.subarray(entry.bodyOffset, entry.bodyOffset + entry.compressedSize);
  const raw = chunkStream(body);
  return entry.method === DEFLATE ? decompress(raw, "deflate-raw") : raw;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export async function readEntry(
  bytes: Uint8Array,
  entries: Map<string, ZipEntryView>,
  name: string,
): Promise<Uint8Array | undefined> {
  const entry = entries.get(name);
  return entry ? await drain(entryStream(bytes, entry)) : undefined;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Reader-side forward compatibility (`../schema.ts`): every object line becomes
 *  an event whatever its `type`, and the record is spread through so unknown
 *  envelope AND payload fields survive. Mirrors `parseEventLog` in
 *  `../artifact.ts` — the two must agree or a log would read differently
 *  depending on which side opened it. */
export function parseEventLine(line: string): ReplayEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  return {
    ...rec,
    t: typeof rec.t === "number" ? rec.t : 0,
    type: typeof rec.type === "string" ? rec.type : "unknown",
    v: typeof rec.v === "number" ? rec.v : 0,
    payload: rec.payload,
  };
}

interface ParsedLog {
  events: ReplayEvent[];
  malformed: number;
  bytes: number;
  digest: Uint8Array | undefined;
}

async function hashOf(parts: Uint8Array[], total: number): Promise<Uint8Array | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return new Uint8Array(await subtle.digest("SHA-256", joined));
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Stream `events.jsonl.gz` into parsed events, yielding to the UI between
 * slices. The whole point of this function: a synchronous `JSON.parse` per line
 * over a 200MB log locks the tab for minutes, and a reviewer decides the
 * artifact is broken long before it finishes.
 */
async function parseLog(
  stream: ReadableStream<Uint8Array>,
  digestLimit: number,
  onProgress: (p: OpenProgress) => void,
): Promise<ParsedLog> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: ReplayEvent[] = [];
  let rawParts: Uint8Array[] | undefined = [];
  let malformed = 0;
  let bytes = 0;
  let tail = "";
  let sliceStart = Date.now();

  const takeLines = async (text: string, last: boolean): Promise<void> => {
    tail += text;
    const lines = tail.split("\n");
    tail = last ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim() === "") continue;
      const event = parseEventLine(line);
      if (event) events.push(event);
      else malformed++;
      if (Date.now() - sliceStart >= SLICE_MS) {
        onProgress({ phase: "events", bytes, events: events.length });
        await yieldToUi();
        sliceStart = Date.now();
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (rawParts && bytes > digestLimit) rawParts = undefined;
    rawParts?.push(value);
    await takeLines(decoder.decode(value, { stream: true }), false);
  }
  await takeLines(decoder.decode(), true);
  onProgress({ phase: "events", bytes, events: events.length });

  return {
    events,
    malformed,
    bytes,
    digest: rawParts ? await hashOf(rawParts, bytes) : undefined,
  };
}

function eventsEntry(entries: Map<string, ZipEntryView>): ZipEntryView {
  for (const [name, entry] of entries) {
    if (name.startsWith("events.jsonl")) {
      if (name.endsWith(".zst")) {
        throw new ArtifactOpenError(
          `${name} is zstd-compressed, which this player cannot read. browxai writes events.jsonl.gz.`,
        );
      }
      return entry;
    }
  }
  throw new ArtifactOpenError("the archive carries no events.jsonl");
}

function countScreenshots(entries: Map<string, ZipEntryView>): number {
  let highest = -1;
  for (const name of entries.keys()) {
    if (!name.startsWith("screenshots/")) continue;
    const n = Number.parseInt(name.slice("screenshots/".length), 10);
    if (Number.isFinite(n)) highest = Math.max(highest, n);
  }
  return highest + 1;
}

export async function openArtifact(
  bytes: Uint8Array,
  opts: OpenArtifactOptions = {},
): Promise<OpenedArtifact> {
  const onProgress = opts.onProgress ?? ((): void => undefined);
  onProgress({ phase: "directory", bytes: 0, events: 0 });
  const entries = readCentralDirectory(bytes);

  onProgress({ phase: "manifest", bytes: 0, events: 0 });
  const manifestRaw = await readEntry(bytes, entries, "manifest.json");
  if (!manifestRaw) throw new ArtifactOpenError("the archive carries no manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as ReplayManifest;

  const logEntry = eventsEntry(entries);
  const gunzipped = decompress(entryStream(bytes, logEntry), "gzip");
  const parsed = await parseLog(gunzipped, opts.digestLimit ?? DIGEST_VERIFY_LIMIT, onProgress);

  onProgress({ phase: "verify", bytes: parsed.bytes, events: parsed.events.length });
  const digestVerified = parsed.digest ? hex(parsed.digest) === manifest.eventsDigest : undefined;

  onProgress({ phase: "done", bytes: parsed.bytes, events: parsed.events.length });
  return {
    manifest,
    events: parsed.events,
    malformed: parsed.malformed,
    digestVerified,
    screenshotCount: countScreenshots(entries),
    asset: (digest) => readEntry(bytes, entries, `assets/${digest}`),
    screenshot: (index) => readEntry(bytes, entries, `screenshots/${index}.webp`),
    video: () => readEntry(bytes, entries, "video.webm"),
  };
}
