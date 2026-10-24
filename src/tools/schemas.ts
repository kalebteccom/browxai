import { z } from "zod";

// Shared input-schema fragments for the MCP tool surface. These live in a leaf
// module — depended on by both the composition root (`createServer`) and the
// per-family tool modules under `src/tools/` — so neither side has to import the
// other. Keeping them here is what lets `action-tools.ts` depend on the host
// seam alone instead of reaching back into `../server.js` (which would close an
// import cycle).

const SNAPSHOT_MODE = z
  .enum(["scoped_snapshot", "tree_diff", "full", "none"])
  .optional()
  .describe(
    'Shape of `snapshotDelta` in the result. Default "scoped_snapshot": re-snapshot the acted element plus new regions, and omit the tree when nothing changed. "none" omits the tree. "tree_diff" returns only the new region subtrees. "full" returns the whole post-action tree and costs the most tokens.',
  );

// every browser-touching tool accepts an optional `session` id.
// Omitting it resolves to the lazily-created "default" session — byte-identical
// to pre-2.5 single-session behaviour. Distinct ids get fully isolated state
// (own RefRegistry, own BrowserContext / cookie jar, own buffers).
export const SESSION_ARG = {
  session: z
    .string()
    .optional()
    .describe(
      'Session id (default "default"), a plain name: letters, digits, `.`, `_`, `-`. Each id is an isolated browser context (own cookie jar, own refs) and is created on first use; `open_session` sets options up front and `list_sessions` lists them.',
    ),
};

// per-call anti-wedge override. Default comes from config
// `actionTimeoutMs` (5000). The wording deliberately deters large values.
export const TIMEOUT_ARG = {
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .optional()
    .describe(
      "Anti-wedge hard deadline for this call (ms). Default 5000 (config `actionTimeoutMs`). " +
        "An action needing >5s is almost always a no-op or a wedged page op. When a call " +
        "times out, the fix is to retry it ONCE or — if timeouts keep recurring — discard " +
        "the session (`close_session` then `open_session`), NOT a bigger timeout: raising " +
        "this never recovers a wedged session. Raise it ONLY for one specific known-slow " +
        "call, never as a blanket. Values approaching the 3600000 (1h) ceiling are " +
        "essentially always a mistake; over-ceiling is clamped + warned.",
    ),
};

export const ACTION_OPTS = {
  mode: SNAPSHOT_MODE,
  maxResultTokens: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .optional()
    .describe(
      "Approximate token cap for `snapshotDelta.tree` (default 600, max 20000). A cut is reported in `warnings`.",
    ),
  ...TIMEOUT_ARG,
  ...SESSION_ARG,
};

// `target` accepts ref *or* selector *or* named *or* coords. Validated at
// handler time. `contextRef` optionally scopes a `selector` to a prior ref's
// subtree. `coords` is the escape hatch for visually-located targets (canvas,
// custom-painted UIs, dismiss-empty-space) — only click/hover honour it.
export const REF_OR_SELECTOR = {
  ref: z
    .string()
    .optional()
    .describe(
      "Stable [eN] ref from snapshot() or find(). Refs reset when the page changes: a stale ref errors, so call snapshot or find again.",
    ),
  selector: z.string().optional().describe("CSS / selectorHint fallback"),
  named: z.string().optional().describe("Mnemonic name previously bound with name_ref"),
  contextRef: z
    .string()
    .optional()
    .describe(
      "Resolve `selector` within the subtree of this ref (from a prior snapshot/find). Lets you say 'the X *inside* this row/card/panel' without baking positional :nth chains into the selector. Ignored when `ref` or `named` is used.",
    ),
  coords: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe(
      "Page-coordinate target {x,y} (CSS px, viewport-relative) for canvas and custom-painted UIs that ref and selector can't address. Check the point with `point_probe` first. Used by click, hover, double_click, wait_for, scroll and drop_files. Other tools refuse it or ignore it.",
    ),
};
