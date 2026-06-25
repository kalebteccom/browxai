// Cross-tool primitive shapes shared across the per-tool SDK type sections.
//
// This is the LEAF of the `tool-types` split: every section file
// (`tool-types-read.ts`, `tool-types-action.ts`, `tool-types-session.ts`,
// `tool-types-capability-gated.ts`) imports its shared inputs from HERE, never
// from the `tool-types.js` barrel — that back-import would be a cycle the
// dependency-cruiser `no-circular` rule rejects. See `tool-types.ts` for the
// authoritative header on why this surface exists and how it relates to the
// server's zod schemas.

// =============================================================================
// Cross-tool shapes
// =============================================================================

/** Session id binding for any browser-touching tool — omitting it resolves
 *  to the lazy "default" session, byte-identical to the MCP path. */
export interface SessionArg {
  session?: string;
}

/** Anti-wedge deadline override for a single call. */
export interface TimeoutArg {
  timeoutMs?: number;
}

/** Snapshot-delta shape for action-tool results. */
export type SnapshotMode = "scoped_snapshot" | "tree_diff" | "full" | "none";

/** Common per-call inputs for action tools (ACTION_OPTS in src/server.ts). */
export interface ActionOpts extends SessionArg, TimeoutArg {
  mode?: SnapshotMode;
  maxResultTokens?: number;
}

/** Viewport coordinate (CSS px, viewport-relative). */
export interface Coords {
  x: number;
  y: number;
}

/** Target shape for tools that accept all four target kinds (click/hover). */
export type Target =
  | { ref: string; selector?: never; named?: never; coords?: never; contextRef?: string }
  | { selector: string; ref?: never; named?: never; coords?: never; contextRef?: string }
  | { named: string; ref?: never; selector?: never; coords?: never; contextRef?: string }
  | { coords: Coords; ref?: never; selector?: never; named?: never; contextRef?: never };

/** Target shape for tools that reject `coords` (fill / select / press / verify family / inspect / ...). */
export type RefTarget =
  | { ref: string; selector?: never; named?: never; contextRef?: string }
  | { selector: string; ref?: never; named?: never; contextRef?: string }
  | { named: string; ref?: never; selector?: never; contextRef?: string };
