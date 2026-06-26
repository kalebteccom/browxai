// SDK envelope parsing — the concrete decode step shared by every transport
// adapter. Each transport produces an MCP content array on the wire; this
// turns that array into the SDK's `BrowxaiResult`. Kept as a leaf (depends
// only on ./types.js) so transport.ts can re-export it for back-compat
// without forming an import cycle through the transport barrel.

import type { BrowxaiContentItem, BrowxaiResult } from "./types.js";

/** Parse the first text item of an MCP content array as JSON, when applicable. */
export function parseEnvelope(content: ReadonlyArray<BrowxaiContentItem>): BrowxaiResult {
  for (const item of content) {
    if (item && item.type === "text") {
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { content, data: parsed as Record<string, unknown> };
        }
      } catch {
        /* not JSON — a snapshot tree or other plain-text payload */
      }
      return { content };
    }
  }
  return { content };
}
