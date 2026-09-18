// A lossless PNG crop, in `node:zlib` and nothing else.
//
// `adb exec-out screencap -p` hands back one PNG of the whole display, so every
// element-scoped or region capture on a native session is a crop of that frame
// (RFC 0008 §2: "Region and marks crop from the full frame using hierarchy
// bounds"). Doing that needs pixels, and pixels need the IDAT stream inflated,
// unfiltered, cut and re-emitted.
//
// WHY NO IMAGE LIBRARY. `sharp` is Apache-2.0 and would be licence-clean, but it
// ships a native libvips binary per platform, and browxai bundles no media
// binaries — the same rule RFC 0008 §5 applies when it refuses to bundle ffmpeg
// for a video transcode. `pngjs` is MIT and pure JS, but it is a dependency for
// ~150 lines of format work that `zlib` already does the hard half of. So this is
// hand-rolled, narrow, and refuses everything outside the one encoding
// `screencap` actually emits.
//
// The crop is EXACT: the pixels that come out are the pixels that went in. The
// re-emitted image uses filter type 0 (None) on every row, which is larger than
// an optimally-filtered PNG and identical in content. A screenshot is evidence,
// so size loses to fidelity and to having no decoder in the trust path.

import { crc32, deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Raised for a PNG this cropper will not touch. Named, because the caller turns
 *  it into a refusal that says what to do instead. */
export class PngCropError extends Error {
  constructor(detail: string) {
    super(`png-crop-unsupported: ${detail}`);
    this.name = "PngCropError";
  }
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** Bytes per pixel for the two true-colour types `screencap` emits. */
function channelsFor(colorType: number): number {
  if (colorType === 2) return 3; // RGB
  if (colorType === 6) return 4; // RGBA
  throw new PngCropError(
    `colour type ${colorType}. \`screencap\` emits RGB or RGBA and only those are cropped here.`,
  );
}

/** Walk the chunk stream, returning the header and the concatenated IDAT data. */
function readChunks(png: Buffer): { header: PngHeader; idat: Buffer } {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new PngCropError("not a PNG");
  let offset = 8;
  let header: PngHeader | undefined;
  const idatParts: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body.readUInt8(8),
        colorType: body.readUInt8(9),
        interlace: body.readUInt8(12),
      };
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new PngCropError("no IHDR chunk");
  if (header.bitDepth !== 8) throw new PngCropError(`bit depth ${header.bitDepth}, expected 8`);
  if (header.interlace !== 0) throw new PngCropError("interlaced PNGs are not cropped");
  if (!idatParts.length) throw new PngCropError("no IDAT data");
  return { header, idat: Buffer.concat(idatParts) };
}

/** Reverse the per-row filters, producing raw pixel rows. The five filter types
 *  are the PNG spec's, and each is defined against the pixel to the left (`a`),
 *  the pixel above (`b`) and the pixel up-left (`c`). */
function unfilter(raw: Buffer, header: PngHeader, bpp: number): Buffer {
  const stride = header.width * bpp;
  const out = Buffer.alloc(stride * header.height);
  let pos = 0;
  for (let y = 0; y < header.height; y++) {
    const filter = raw[pos++]!;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos++]!;
      const a = x >= bpp ? row[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      row[x] = (value + predictor(filter, a, b, c)) & 0xff;
    }
  }
  return out;
}

function predictor(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >> 1;
    case 4:
      return paeth(a, b, c);
    default:
      throw new PngCropError(`filter type ${filter}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Crop a PNG to a rectangle in its own pixel space.
 *
 *  The rect is CLAMPED to the image rather than refused when it overhangs: a
 *  UiAutomator node's bounds can extend past the display (a view laid out under
 *  the navigation bar reports the full box), and refusing a capture over one
 *  clipped pixel row would be worse than returning the visible part. A rect
 *  entirely outside the image has nothing to return and throws. */
export function cropPng(
  png: Buffer,
  rect: { x: number; y: number; width: number; height: number },
): Buffer {
  const { header, idat } = readChunks(png);
  const bpp = channelsFor(header.colorType);
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(header.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(header.height, Math.round(rect.y + rect.height));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) {
    throw new PngCropError(
      `the rectangle (${rect.x},${rect.y} ${rect.width}x${rect.height}) does not overlap the ` +
        `${header.width}x${header.height} frame`,
    );
  }
  const pixels = unfilter(inflateSync(idat), header, bpp);
  const srcStride = header.width * bpp;
  const dstStride = width * bpp;
  // One filter byte (type 0, None) then the row's bytes.
  const body = Buffer.alloc((dstStride + 1) * height);
  for (let y = 0; y < height; y++) {
    const from = (y0 + y) * srcStride + x0 * bpp;
    body[y * (dstStride + 1)] = 0;
    pixels.copy(body, y * (dstStride + 1) + 1, from, from + dstStride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(header.bitDepth, 8);
  ihdr.writeUInt8(header.colorType, 9);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(body)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The image's pixel dimensions, for a caller that needs them without decoding. */
export function pngSize(png: Buffer): { width: number; height: number } {
  const { header } = readChunks(png);
  return { width: header.width, height: header.height };
}
