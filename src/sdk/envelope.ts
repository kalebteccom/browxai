// SDK result decoding, shared by every transport adapter. Each transport
// produces an MCP content array on the wire; `unwrapResult` turns it into the
// value a typed SDK method resolves to. Kept as a leaf (depends only on
// ./types.js) so transport.ts can re-export it without forming an import cycle
// through the transport barrel.

import type { BrowxaiContentItem, BrowxaiResult } from "./types.js";

/** Parse the first text item of an MCP content array as JSON, when applicable.
 *  This is the `{ content, data }` envelope. {@link unwrapResult} still returns
 *  it for a result that carries more than one text item, or an item that is not
 *  text, because a single value cannot hold those. */
export function parseEnvelope(content: ReadonlyArray<BrowxaiContentItem>): BrowxaiResult {
  for (const item of content) {
    if (item && item.type === "text") {
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { content, data: parsed as Record<string, unknown> };
        }
      } catch {
        /* not JSON: a snapshot tree or other plain-text payload */
      }
      return { content };
    }
  }
  return { content };
}

/**
 * The value an SDK method resolves to, one rule for every tool:
 *
 *   - The result is a single text item: its text parsed as JSON when that gives
 *     an object or an array, else the text string itself. A text that parses to a
 *     bare number, boolean or null stays a string.
 *   - Anything else (an image item, several items, no items): the
 *     `{ content, data? }` envelope from {@link parseEnvelope}, so the raw MCP
 *     content stays reachable. `screenshot` and `screenshot_marks` come back this
 *     way.
 *
 * A tool that fails on the server returns its message as text, so it resolves
 * to a string, as it always did (it had no `data`). `isError` is not surfaced.
 */
export function unwrapResult(content: ReadonlyArray<BrowxaiContentItem>): unknown {
  const only = content.length === 1 ? content[0] : undefined;
  if (only && only.type === "text") {
    try {
      const parsed: unknown = JSON.parse(only.text);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      /* not JSON: a snapshot tree or other plain-text payload */
    }
    return only.text;
  }
  return parseEnvelope(content);
}
