// Cheap token estimation + truncation helpers. ActionResult.snapshotDelta is the
// elastic part of the structured result — when the budget is tight, we shrink it
// first before dropping anything else.

export function estimateTokens(text: string): number {
  // Order-of-magnitude estimate — 1 token ≈ 4 chars of English / structured text.
  // We're not pricing API calls; we're sizing payloads. Good enough.
  return Math.ceil(text.length / 4);
}

/** Truncate `text` (line-wise) so its estimated token count is ≤ `maxTokens`. */
export function truncateToBudget(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const lines = text.split("\n");
  // Keep dropping last lines until we fit; add a final "... [N more lines]" marker.
  let kept = lines.length;
  while (kept > 1) {
    const candidate = lines.slice(0, kept).join("\n") + `\n... [+${lines.length - kept} more]`;
    if (estimateTokens(candidate) <= maxTokens) {
      return { text: candidate, truncated: true };
    }
    kept = Math.max(1, Math.floor(kept * 0.75));
  }
  return { text: `... [${lines.length} lines elided]`, truncated: true };
}
