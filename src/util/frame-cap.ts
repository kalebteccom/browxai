// Per-frame payload cap for the WS/SSE rings and the replay log.
//
// A frame over the cap is masked before it is cut. Cutting first would split a
// registered value that straddles the cut, and the kept head of that value no
// longer matches the mask applied later.

/** A frame payload after the cap, with `truncated` set when it was cut. */
export interface CappedPayload {
  payload: string;
  truncated?: boolean;
}

/**
 * Cap `raw` at `max` characters. A payload within the cap comes back as given,
 * since every reader masks it whole later. A longer one goes through `mask`
 * first, then is cut.
 */
export function capFramePayload(
  raw: string,
  max: number,
  mask: ((s: string) => string) | null,
): CappedPayload {
  if (raw.length <= max) return { payload: raw };
  const masked = mask ? mask(raw) : raw;
  if (masked.length <= max) return { payload: masked };
  return { payload: masked.slice(0, max), truncated: true };
}
