// Text caps that run before the registered-secret mask: frame payloads, response
// bodies, console messages, worker messages and page-text evidence fields.
//
// Text over a cap is masked before it is cut. Cutting first splits a registered
// value that crosses the cut, and the kept head of that value no longer matches
// the mask applied later.
//
// Two shapes of input:
//   - The whole text is on the server (`capMasked`). Only a window of it is
//     masked, so a multi-megabyte body is not scanned whole.
//   - The text was read with a cap somewhere else, usually by a page function
//     that read `cap + slack + 1` characters (`clipMasked`, `clipPageText`).
// Either way the head of the input is all that was masked, so a value that
// crosses the end of that head is not masked, and it sits wholly inside the
// last `slack` characters of the masked head. Those characters are never kept.

/** A secrets mask over one string. */
export type Mask = (s: string) => string;

/** How a sink masks text before it cuts it: the session mask and the longest
 *  registered form less one (`SecretRegistry.maskSlack`). `{ mask: null,
 *  slack: 0 }` when nothing is registered, which leaves every cut as it was. */
export interface TextCut {
  mask: Mask | null;
  slack: number;
}

/** No mask, no slack: the cut a sink made before any secret existed. */
export const PLAIN_CUT: TextCut = { mask: null, slack: 0 };

/** The `TextCut` for a session registry, `PLAIN_CUT` when it is absent or
 *  empty. */
export function textCutFor(
  secrets:
    { size(): number; maskSlack(): number; applyMaskInText(s: string): string } | null | undefined,
): TextCut {
  if (!secrets || secrets.size() === 0) return PLAIN_CUT;
  return { mask: (s) => secrets.applyMaskInText(s), slack: secrets.maskSlack() };
}

/** A payload after the cap, with `truncated` set when it was cut. */
export interface CappedPayload {
  payload: string;
  truncated?: boolean;
}

/**
 * Cap `raw` at `max` characters. Text within the cap comes back as given,
 * since every reader masks it whole later. Longer text is masked, then cut.
 *
 * `slack` bounds the masked window to `max + slack` characters. When masking
 * shortens the window so that its last `slack` characters would land inside
 * the kept `max`, the window grows and is masked again, so a value that
 * crosses the window's end never reaches the output. `Infinity` masks the
 * whole text.
 */
export function capMasked(
  raw: string,
  max: number,
  mask: Mask | null,
  slack = Infinity,
): CappedPayload {
  if (raw.length <= max) return { payload: raw };
  if (!mask) return { payload: raw.slice(0, max), truncated: true };
  let end = Math.min(raw.length, max + slack);
  let masked = mask(raw.slice(0, end));
  // bound: `end` grows by at least 1 on every pass and stops at `raw.length`.
  while (end < raw.length && masked.length - slack < max) {
    end = Math.min(raw.length, end + Math.max(slack, max - (masked.length - slack) + slack, 1));
    masked = mask(raw.slice(0, end));
  }
  if (end >= raw.length && masked.length <= max) return { payload: masked };
  return { payload: masked.slice(0, max), truncated: true };
}

/** The frame-ring name for `capMasked` over the whole payload. */
export function capFramePayload(raw: string, max: number, mask: Mask | null): CappedPayload {
  return capMasked(raw, max, mask);
}

/** Options for `clipMasked`. */
export interface ClipOptions {
  /** `raw` is the head of a longer text. Its last `slack` characters may hold
   *  the head of a value that crosses the end, so they are never kept. */
  cut?: boolean;
  slack?: number;
  /** Appended when the text was cut. Empty by default. */
  marker?: string;
  /** Characters kept before the marker. Default `max - marker.length`. */
  keep?: number;
}

/**
 * Mask `raw`, then cut it. Text that was not cut upstream and fits in `max`
 * after masking comes back masked and whole. Otherwise the first `keep`
 * characters are kept, fewer when `cut` is set and the masked head is shorter
 * than `keep + slack`, and `marker` is appended.
 */
export function clipMasked(
  raw: string,
  max: number,
  mask: Mask | null,
  opts: ClipOptions = {},
): string {
  const { cut = false, slack = 0, marker = "" } = opts;
  const keep = opts.keep ?? max - marker.length;
  const masked = mask ? mask(raw) : raw;
  if (!cut && masked.length <= max) return masked;
  const safe = cut ? Math.max(0, masked.length - slack) : masked.length;
  return masked.slice(0, Math.min(keep, safe)) + marker;
}

/**
 * Finish a page-text field that a page function read as at most
 * `cap + slack + 1` characters (`pageReadLength`): mask it, then cut it to
 * `cap` the way the page used to. A field longer than `cap + slack` was cut by
 * the page.
 */
export function clipPageText(
  raw: string,
  cap: number,
  cut: TextCut,
  opts: Pick<ClipOptions, "marker" | "keep"> = {},
): string {
  return clipMasked(raw, cap, cut.mask, {
    ...opts,
    cut: raw.length > cap + cut.slack,
    slack: cut.slack,
  });
}

/** How many characters a page function reads for a field the server cuts to
 *  `cap`: one past `cap + slack`, so the server can tell a cut field from one
 *  that fits. */
export function pageReadLength(cap: number, slack: number): number {
  return cap + slack + 1;
}
