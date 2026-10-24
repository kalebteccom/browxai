// set-of-marks — composed PNG with numbered bounding boxes painted over
// caller-supplied candidates. Pure compose over existing primitives (find /
// snapshot / refs / bbox); no new browser interaction beyond a transient
// in-page overlay.
//
// Numbering shares the `name_ref` / `eN` namespace deliberately. When
// `label:"ref"`, each box renders the existing `eN` ref; when `label:"index"`
// (the default), the box renders the 1..N array position AND the result also
// carries an `{ index → ref }` mapping so the LLM can address the same
// element either way. We do not invent a parallel ID space.
//
// Image-library choice: an in-page overlay drawn via DOM + an absolute-positioned
// container, then `page.screenshot()`. browxai has no Node-side image library
// (sharp / canvas / jimp) in `dependencies`, and adding one would pull native
// bindings + ~MBs of install weight for a single drawing primitive. The
// in-page overlay is dependency-free, runs in the same coordinate space as
// `find().evidence.bbox` (CSS pixels, viewport-relative — exactly the rect
// `visibleRect` returns), and is removed before we return so it never leaks
// state into a follow-up read.

import type { CDPSession, Page } from "playwright-core";
import type { FindCandidate } from "./find.js";
import type { RefLocatorInputs, RefRegistry } from "./refs.js";
import { visibleRect, type VisibleRect } from "./bbox.js";
import { locatorFor } from "./locator.js";
import type { SnapshotSubstrate } from "./snapshot-substrate.js";
import { walk, type A11yNode } from "./a11y.js";

export type LabelMode = "index" | "ref" | "role";

export interface MarkCandidateRef {
  /** Stable `eN` ref previously surfaced by snapshot/find. */
  ref: string;
}

/** A pre-computed `find()` candidate. The caller can pass the full object
 *  through — we only consume `ref`, `role`, `name`, `testId`, and `bbox`. */
export type MarkCandidate =
  MarkCandidateRef | Pick<FindCandidate, "ref" | "role" | "name" | "testId" | "bbox">;

export interface SetOfMarksOptions {
  candidates: MarkCandidate[];
  /** How to label each painted box. Default `"index"` — the array-position
   *  numbering 1..N (paired with `mapping` so the agent can convert to `eN`).
   *  `"ref"` paints the existing `eN` directly. `"role"` paints the candidate's
   *  role (useful when the agent already has refs and wants visual grounding
   *  on what each box *is*). */
  label?: LabelMode;
  /** Configured test-attribute list — required if any candidate is a bare
   *  `{ref}` and we have to resolve its bbox via the composed tree walk.
   *  When every candidate already carries `bbox`, unused. */
  testAttributes?: string[];
}

export interface MarkEntry {
  /** 1-based array position. Stable for the duration of the call result. */
  index: number;
  /** Existing `eN` ref — the cross-snapshot-stable identity. */
  ref: string;
  role?: string;
  name?: string;
  testId?: string;
  bbox: VisibleRect | null;
  /** True when this candidate was painted on the image. A candidate with a
   *  null bbox (fully clipped / off-screen) is reported but not painted. */
  painted: boolean;
}

export interface SetOfMarksResult {
  /** base64-encoded PNG of the viewport with the painted overlay. */
  imageBase64: string;
  mimeType: "image/png";
  /** Per-candidate row: array position, ref, role/name/testId, the bbox we
   *  painted (or null), and whether it landed on the image. The agent can
   *  index 1..N OR address `eN` — same identity. */
  marks: MarkEntry[];
  /** Convenience: `{ "1": "e7", "2": "e3", … }`. Lets the LLM say "click 2"
   *  and the harness translate back to `click({ref:"e3"})`. */
  mapping: Record<string, string>;
  /** Non-fatal notes (candidates with no bbox, ref-only inputs we couldn't
   *  resolve, etc.). Same convention as `find()`'s `warnings`. */
  warnings: string[];
}

/** Type guard: does this candidate already carry a bbox (i.e. is it the
 *  full `FindCandidate`-shaped object)? */
function hasBbox(
  c: MarkCandidate,
): c is Pick<FindCandidate, "ref" | "role" | "name" | "testId" | "bbox"> {
  return Object.prototype.hasOwnProperty.call(c, "bbox");
}

/**
 * Resolve a list of `MarkCandidate`s (mixed `{ref}` and full-candidate shape)
 * into `MarkEntry` rows. A bare `{ref}` resolves through the ref table (see
 * `resolveBareRef`), with one composed-tree walk for role/name and the CDP
 * node id. Exported for unit-test composition.
 */
/** The page-side dependencies `resolveCandidates` threads through (bundled so the
 *  signature stays within the parameter budget). `cdp` is the chromium-only
 *  visible-rect fast path; off Chromium it is undefined and bbox computes via the
 *  portable `locatorBoundingBox` fallback. */
export interface MarksDeps {
  page: Page;
  substrate: SnapshotSubstrate;
  refs: RefRegistry;
  testAttributes: string[];
  cdp?: CDPSession;
}

/** Build the ref→node lookup by walking the composed tree once, so each bare-ref
 *  candidate's `backendDOMNodeId` resolves exactly as `find()` would. Returns
 *  null + pushes a warning on compose failure. */
async function buildRefLookup(
  deps: MarksDeps,
  warnings: string[],
): Promise<Map<string, A11yNode> | null> {
  try {
    const { tree } = await deps.substrate.compose(deps.refs, deps.testAttributes);
    if (!tree) return null;
    const m = new Map<string, A11yNode>();
    for (const { node } of walk(tree)) {
      if (!m.has(node.ref)) m.set(node.ref, node);
    }
    return m;
  } catch (err) {
    warnings.push(
      `set-of-marks: bbox lookup for bare ref candidates failed (${err instanceof Error ? err.message : String(err)}); ` +
        `bare refs resolve from the ref table alone, without the CDP rect path.`,
    );
    return null;
  }
}

/** Build a mark entry from a node (carrying its optional role/name/testId). */
function markEntryFrom(index: number, node: MarkEntrySource, bbox: VisibleRect | null): MarkEntry {
  return {
    index,
    ref: node.ref,
    ...(node.role !== undefined ? { role: node.role } : {}),
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.testId !== undefined ? { testId: node.testId } : {}),
    bbox,
    painted: bbox !== null,
  };
}

type MarkEntrySource = { ref: string; role?: string; name?: string; testId?: string };

/** Per-box cap for the portable locator fallback. Bare refs resolve in
 *  parallel, so the whole batch waits at most this long, inside the tool's
 *  anti-wedge deadline. */
const BARE_REF_BOX_TIMEOUT_MS = 1000;

/** The role/name/testId a ref's locator record carries, for a ref the current
 *  walk did not surface. */
function sourceFromInputs(ref: string, inputs: RefLocatorInputs): MarkEntrySource {
  return {
    ref,
    role: inputs.role,
    ...(inputs.name !== undefined ? { name: inputs.name } : {}),
    ...(inputs.testId !== undefined ? { testId: inputs.testId } : {}),
  };
}

/** Box of a ref through the same locator an action resolves it with. Null when
 *  the locator matches nothing, has no size, or times out. */
async function refTableBox(deps: MarksDeps, ref: string): Promise<VisibleRect | null> {
  try {
    const box = await locatorFor(deps.page, deps.refs, { ref }).boundingBox({
      timeout: BARE_REF_BOX_TIMEOUT_MS,
    });
    if (!box || box.width <= 0 || box.height <= 0) return null;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  } catch {
    return null;
  }
}

/** Resolve one bare-ref candidate's bbox. The ref table is the source of
 *  truth: a ref `find()` or `snapshot` minted resolves through the same
 *  `locatorFor` an action uses (test attribute, structural path for DOM-walk
 *  refs, role and name otherwise), so a DOM-walk ref whose bare-tag role has no
 *  role selector still gets a box. The CDP visible-rect path runs first when
 *  the current walk carries the node's backend id. A ref the table has never
 *  seen is reported by name instead of painted as an empty box. */
async function resolveBareRef(
  deps: MarksDeps,
  index: number,
  ref: string,
  lookupByRef: Map<string, A11yNode> | null,
): Promise<{ entry: MarkEntry; warning?: string }> {
  const looked = lookupByRef?.get(ref);
  const inputs = deps.refs.locatorOf(ref);
  if (!looked && !inputs) {
    return {
      entry: { index, ref, bbox: null, painted: false },
      warning:
        `set-of-marks: ref "${ref}" is not in the ref table, so there is no box to paint. ` +
        `Refs reset when the page changes: call snapshot() or find() for fresh ones, or pass the full find() candidate.`,
    };
  }
  const source: MarkEntrySource = looked ?? sourceFromInputs(ref, inputs!);
  let bbox: VisibleRect | null =
    deps.cdp !== undefined && looked?.backendDOMNodeId !== undefined
      ? await visibleRect(deps.cdp, looked.backendDOMNodeId)
      : null;
  if (bbox === null) bbox = await refTableBox(deps, ref);
  return { entry: markEntryFrom(index, source, bbox) };
}

export async function resolveCandidates(
  deps: MarksDeps,
  candidates: MarkCandidate[],
): Promise<{ entries: MarkEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  // Fast-path: when every candidate already carries a bbox (e.g. piped straight
  // from a prior find()), skip the tree walk entirely.
  const lookupByRef = candidates.every(hasBbox) ? null : await buildRefLookup(deps, warnings);

  // Bare refs resolve in parallel: each can wait out its locator timeout, and
  // ten of them in sequence overran the tool deadline.
  const resolved = await Promise.all(
    candidates.map(async (c, i) => {
      if (hasBbox(c)) return { entry: markEntryFrom(i + 1, c, c.bbox) };
      return resolveBareRef(deps, i + 1, c.ref, lookupByRef);
    }),
  );
  const entries: MarkEntry[] = [];
  for (const r of resolved) {
    entries.push(r.entry);
    if (r.warning) warnings.push(r.warning);
  }
  return { entries, warnings };
}

/** Pure label-builder. Exported for unit-test direct coverage. */
export function labelFor(entry: MarkEntry, mode: LabelMode): string {
  switch (mode) {
    case "ref":
      return entry.ref;
    case "role":
      return entry.role ?? entry.ref;
    case "index":
    default:
      return String(entry.index);
  }
}

/** Build the in-page overlay-painter script. Inlines the painted boxes
 *  (already resolved server-side) — page-side does no DOM walking, only
 *  paints absolute-positioned <div>s + a label badge per box, returning the
 *  element id of the overlay container so we can remove it after. */
function buildOverlayScript(
  paintedBoxes: Array<{ x: number; y: number; width: number; height: number; label: string }>,
): string {
  const data = JSON.stringify(paintedBoxes);
  return `(() => {
    var BOXES = ${data};
    var OVERLAY_ID = 'browxai-set-of-marks-' + Math.random().toString(36).slice(2);
    var root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = [
      'position:fixed',
      'left:0','top:0','right:0','bottom:0',
      'pointer-events:none',
      'z-index:2147483647',
      'margin:0','padding:0',
      'background:transparent',
    ].join(';');
    BOXES.forEach(function (b) {
      var box = document.createElement('div');
      box.style.cssText = [
        'position:absolute',
        'left:' + b.x + 'px','top:' + b.y + 'px',
        'width:' + b.width + 'px','height:' + b.height + 'px',
        'box-sizing:border-box',
        'border:2px solid #ff0066',
        'background:rgba(255,0,102,0.08)',
        'border-radius:2px',
      ].join(';');
      var badge = document.createElement('div');
      badge.textContent = b.label;
      // Default badge corner: top-left of the box, pulled outward so it
      // doesn't occlude the box's contents. When the box hugs an edge of the
      // viewport, flip the badge to the box's inside corner so it stays in
      // frame for the screenshot.
      var anchorTop = b.y >= 22;
      var anchorLeft = b.x >= 24;
      var tx = anchorLeft ? '-100%' : '100%';
      var ty = anchorTop ? '-100%' : '100%';
      var styles = [
        'position:absolute',
        anchorTop ? 'top:-2px' : 'bottom:-2px',
        anchorLeft ? 'left:-2px' : 'right:-2px',
        'transform:translate(' + tx + ',' + ty + ')',
        'min-width:18px','height:18px','line-height:18px',
        'padding:0 5px','box-sizing:border-box',
        'background:#ff0066','color:#fff',
        'font:bold 12px/18px ui-sans-serif,system-ui,-apple-system,sans-serif',
        'text-align:center','border-radius:9px',
        'box-shadow:0 1px 2px rgba(0,0,0,0.35)',
        'white-space:nowrap',
      ];
      badge.style.cssText = styles.join(';');
      box.appendChild(badge);
      root.appendChild(box);
    });
    document.documentElement.appendChild(root);
    return OVERLAY_ID;
  })()`;
}

/** Remove the overlay element previously installed by buildOverlayScript. */
function buildRemoveScript(overlayId: string): string {
  return `(() => {
    var el = document.getElementById(${JSON.stringify(overlayId)});
    if (el && el.parentNode) el.parentNode.removeChild(el);
    return true;
  })()`;
}

/**
 * Compose a single PNG screenshot of the current viewport with numbered
 * bounding boxes painted over the supplied candidates. The numbering scheme
 * shares the existing `eN` ref namespace (index↔ref mapping returned).
 *
 * `bbox` is honoured exactly as `find()` reported it — visible-rect with
 * ancestor-overflow + viewport intersection applied (see `src/page/bbox.ts`).
 * A candidate with `bbox: null` is **not** painted; it's listed in `marks`
 * with `painted: false` and a `warnings` entry, so the caller knows the
 * mapping still resolves but the box wasn't visible.
 *
 * The overlay is installed for the duration of the screenshot only and
 * removed before this function returns. Failures during removal are
 * best-effort (we still return the image + the warning).
 */
export async function screenshotMarks(
  page: Page,
  substrate: SnapshotSubstrate,
  refs: RefRegistry,
  opts: SetOfMarksOptions,
  /** CDP handle for the visible-rect bbox fast path — chromium only. */
  cdp?: CDPSession,
): Promise<SetOfMarksResult> {
  const testAttributes = opts.testAttributes ?? [];
  const label: LabelMode = opts.label ?? "index";
  const { entries, warnings } = await resolveCandidates(
    { page, substrate, refs, testAttributes, cdp },
    opts.candidates,
  );

  // Only paint entries that have a bbox to paint.
  const paintedBoxes = entries
    .filter((e) => e.bbox !== null)
    .map((e) => ({
      x: e.bbox!.x,
      y: e.bbox!.y,
      width: e.bbox!.width,
      height: e.bbox!.height,
      label: labelFor(e, label),
    }));

  let overlayId: string | null = null;
  let imageBase64 = "";
  try {
    if (paintedBoxes.length > 0) {
      overlayId = await page.evaluate(buildOverlayScript(paintedBoxes));
    }
    const buf = await page.screenshot({ type: "png", fullPage: false });
    imageBase64 = Buffer.from(buf).toString("base64");
  } finally {
    if (overlayId) {
      try {
        await page.evaluate(buildRemoveScript(overlayId));
      } catch {
        warnings.push(
          `set-of-marks: overlay removal failed; a stray <div id="${overlayId}"> may persist until the next navigation.`,
        );
      }
    }
  }

  // Tally un-paintable candidates as warnings (one terse line, not one per
  // entry — the per-entry `painted:false` already encodes it).
  const skipped = entries.filter((e) => !e.painted).length;
  if (skipped > 0) {
    warnings.push(
      `set-of-marks: ${skipped} of ${entries.length} candidate(s) had no bbox (clipped / off-screen / unresolved) and were not painted on the image. ` +
        `Their entries remain in \`marks\` with \`painted:false\` so the index↔ref mapping is still complete.`,
    );
  }

  const mapping: Record<string, string> = {};
  for (const e of entries) mapping[String(e.index)] = e.ref;

  return {
    imageBase64,
    mimeType: "image/png",
    marks: entries,
    mapping,
    warnings,
  };
}
