// Byte cap for a response body read off Chromium, where the body arrives as
// bytes. A text body over the cap is decoded from a window a little past the
// cap, masked, then cut on a character boundary. Cutting the bytes first could
// split a registered value, and could split a multi-byte character, which used
// to fail the text check and return the whole body as base64.

import type { TextCut } from "./frame-cap.js";

/** A capped body: text (masked) or base64 (not masked here). */
export interface CappedBody {
  body: string;
  base64Encoded: boolean;
  truncated?: true;
}

/** Longest UTF-8 encoding of one UTF-16 unit, so `slack` characters fit in
 *  `4 * slack` bytes. */
const MAX_UTF8_BYTES = 4;

/** `bytes` as text when it decodes as UTF-8 and encodes back to the same
 *  bytes, else null. */
function isUtf8Text(bytes: Buffer): string | null {
  const text = bytes.toString("utf-8");
  return Buffer.from(text, "utf-8").equals(bytes) ? text : null;
}

/** Move `end` back off UTF-8 continuation bytes, so `buf.subarray(0, end)`
 *  does not end inside a character. */
function charBoundary(buf: Buffer, end: number): number {
  let at = end;
  // bound: a UTF-8 character has at most 3 continuation bytes; `at` only falls.
  while (at > 0 && at < buf.length && (buf[at]! & 0xc0) === 0x80) at--;
  return at;
}

/** The first `maxBytes` bytes of `text` as UTF-8, cut on a character
 *  boundary. */
function cutToBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.length <= maxBytes) return { text, cut: false };
  return { text: bytes.subarray(0, charBoundary(bytes, maxBytes)).toString("utf-8"), cut: true };
}

/**
 * Cap `buf` at `maxBytes`. A body within the cap is text masked whole when it
 * is UTF-8, else base64. A longer body is judged on a window of
 * `maxBytes + 4 * slack` bytes that ends on a character boundary: text is
 * masked, its last `slack` characters dropped when the window cut the body
 * (they may hold the head of a value that crosses the window's end), then cut
 * to `maxBytes` bytes on a character boundary. A non-text body comes back as
 * the base64 of its first `maxBytes` bytes, as before.
 */
export function capBodyBytes(buf: Buffer, maxBytes: number, cut: TextCut): CappedBody {
  const mask = cut.mask ?? ((s: string): string => s);
  if (buf.length <= maxBytes) {
    const text = isUtf8Text(buf);
    if (text !== null) return { body: mask(text), base64Encoded: false };
    return { body: buf.toString("base64"), base64Encoded: true };
  }
  const head = maskedHead(buf, maxBytes, mask, cut.slack);
  if (head === null) {
    return {
      body: buf.subarray(0, maxBytes).toString("base64"),
      base64Encoded: true,
      truncated: true,
    };
  }
  const out = cutToBytes(head.text, maxBytes);
  return {
    body: out.text,
    base64Encoded: false,
    ...(head.windowCut || out.cut ? { truncated: true as const } : {}),
  };
}

/** The masked text of a window of `buf` that starts at `maxBytes + 4 * slack`
 *  bytes, or null when that window is not UTF-8 text. When the window cut the
 *  body, its last `slack` characters are dropped; if masking then leaves fewer
 *  than `maxBytes` bytes, the window grows and is masked again. */
function maskedHead(
  buf: Buffer,
  maxBytes: number,
  mask: (s: string) => string,
  slack: number,
): { text: string; windowCut: boolean } | null {
  const pad = MAX_UTF8_BYTES * slack;
  let end = charBoundary(buf, Math.min(buf.length, maxBytes + pad));
  const first = isUtf8Text(buf.subarray(0, end));
  if (first === null) return null;
  let text = safeHead(mask(first), end < buf.length, slack);
  // bound: `end` grows on every pass and stops at `buf.length`.
  while (end < buf.length && Buffer.byteLength(text, "utf-8") < maxBytes) {
    const grow = maxBytes - Buffer.byteLength(text, "utf-8") + pad;
    const next = charBoundary(buf, Math.min(buf.length, end + grow));
    const wider = next > end ? isUtf8Text(buf.subarray(0, next)) : null;
    if (wider === null) break;
    end = next;
    text = safeHead(mask(wider), end < buf.length, slack);
  }
  return { text, windowCut: end < buf.length };
}

/** A masked window less its last `slack` characters when the window cut the
 *  body: a value that crosses the window's end has its head there. */
function safeHead(masked: string, windowCut: boolean, slack: number): string {
  return windowCut && slack > 0 ? dropLastUnits(masked, slack) : masked;
}

/** `text` less its last `n` UTF-16 units, one more when that would leave a
 *  lone high surrogate. */
function dropLastUnits(text: string, n: number): string {
  let end = Math.max(0, text.length - n);
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}
