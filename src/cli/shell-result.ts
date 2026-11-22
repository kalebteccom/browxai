// The document `browxai call` prints for a tool result, and the exit code it ends with.
// Pure: no I/O. The split matches the SDK's: the first text item is parsed as JSON when
// it holds an object or an array, else it is kept as text. Image data never goes into the
// document, only the type and byte length.

/** The process exit codes of `browxai call` and `browxai tools`. */
export const EXIT = {
  /** The tool ran and its result is not an error. */
  ok: 0,
  /** The tool answered with an error result, or `data.ok` is false. */
  toolError: 1,
  /** Usage: an unknown flag, bad arguments, an unreadable file. */
  usage: 2,
  /** The daemon could not be reached. */
  unreachable: 3,
  /** A capability gate refused the call. */
  refused: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** One MCP content item, as far as this module reads it. */
export interface ContentItem {
  readonly type: string;
  readonly text?: unknown;
  readonly data?: unknown;
  readonly mimeType?: unknown;
}

export interface ToolResult {
  readonly content: ReadonlyArray<ContentItem>;
  readonly isError?: boolean;
}

export interface ShellImage {
  readonly mimeType: string;
  readonly bytes: number;
  /** Set when `--out` wrote this image to a file. */
  path?: string;
}

export interface ShellDocument {
  isError: boolean;
  data?: unknown;
  text?: string;
  images: ShellImage[];
  truncated?: { readonly originalChars: number; readonly maxChars: number };
}

export interface Built {
  readonly doc: ShellDocument;
  readonly exitCode: ExitCode;
  /** The first image, base64, for `--out`. Never part of the document. */
  readonly firstImage: { readonly data: string; readonly mimeType: string } | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The exit code for a result, read from the whole result before any truncation. A
 *  refusal from a capability gate (`ok: false` with a `requiredCapability` field) is its
 *  own code, because the caller should not retry it. */
export function exitCodeFor(isError: boolean, data: unknown): ExitCode {
  if (isError) return EXIT.toolError;
  if (isRecord(data) && data.ok === false) {
    return "requiredCapability" in data ? EXIT.refused : EXIT.toolError;
  }
  return EXIT.ok;
}

/** The byte length of a base64 string, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Cut text to `max` characters without leaving half of a surrogate pair. */
export function cutText(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Build the printed document. `maxChars` caps the payload, the JSON of `data` or the
 *  text, and 0 means no cap. A payload over the cap is replaced by `text` holding its first
 *  `maxChars` characters, and `truncated` records the length before the cut. */
export function buildDocument(result: ToolResult, maxChars: number): Built {
  const isError = result.isError === true;
  const doc: ShellDocument = { isError, images: [] };
  let firstImage: Built["firstImage"];
  let firstText: string | undefined;
  for (const item of result.content) {
    const { text, data: pixels, mimeType: mime } = item;
    if (item.type === "text" && firstText === undefined && typeof text === "string") {
      firstText = text;
    } else if (item.type === "image" && typeof pixels === "string") {
      const mimeType = typeof mime === "string" ? mime : "application/octet-stream";
      doc.images.push({ mimeType, bytes: base64Bytes(pixels) });
      firstImage ??= { data: pixels, mimeType };
    }
  }
  let data: unknown;
  if (firstText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(firstText);
      if (typeof parsed === "object" && parsed !== null) data = parsed;
    } catch {
      /* not JSON: a snapshot tree or another plain-text result */
    }
    if (data === undefined) doc.text = firstText;
    else doc.data = data;
  }
  const exitCode = exitCodeFor(isError, data);
  const payload = doc.data !== undefined ? JSON.stringify(doc.data) : doc.text;
  if (payload !== undefined && maxChars > 0 && payload.length > maxChars) {
    delete doc.data;
    doc.text = cutText(payload, maxChars);
    doc.truncated = { originalChars: payload.length, maxChars };
  }
  return { doc, exitCode, firstImage };
}

/** An error result built on the client, for a daemon that answered a call with a protocol
 *  error where a result belongs. */
export function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
