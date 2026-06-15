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
import { buildSelectorHint, type FindCandidate } from "./find.js";
import type { RefRegistry } from "./refs.js";
import { visibleRect, locatorBoundingBox, type VisibleRect } from "./bbox.js";
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
  | MarkCandidateRef
  | Pick<FindCandidate, "ref" | "role" | "name" | "testId" | "bbox">;

export interface SetOfMarksOptions {
  candidates: MarkCandidate[];
  /** How to label each painted box. Default `"index"` — the array-position
   *  numbering 1..N (paired with `mapping` so the agent can convert to `eN`).
   *  `"ref"` paints the existing `eN` directly. `"role"` paints the candidate's
   *  role (useful when the agent already has refs and wants visual grounding
   *  on what each box *is*). */
  label?: LabelMode;
  /** Configured test-attribute list — required if any candidate is a bare
   *  `{ref}` and we have to resolve its bbox via `find()`'s tree walker.
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
 * into `MarkEntry` rows. For bare `{ref}` inputs that aren't already bound to
 * a locator in the registry, we fall back to `find()` over the existing tree
 * to look up the bbox + role/name. Pure-ish: only does a `find()` walk when
 * a bare ref needs resolving. Exported for unit-test composition.
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
        `they will be reported without bboxes. Pass the full find() candidate to avoid the lookup.`,
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

/** Resolve one bare-ref candidate's bbox the same way `find()` does (CDP
 *  visibleRect → portable locatorBoundingBox fallback, capped at 1s). */
async function resolveBareRef(
  deps: MarksDeps,
  index: number,
  ref: string,
  lookupByRef: Map<string, A11yNode> | null,
  warnings: string[],
): Promise<MarkEntry> {
  const looked = lookupByRef?.get(ref);
  if (!looked) {
    warnings.push(
      `set-of-marks: ref "${ref}" was not surfaced by the current snapshot walk — ` +
        `no bbox to paint. Pass the full find() candidate (with bbox) or call snapshot/find first.`,
    );
    return { index, ref, bbox: null, painted: false };
  }
  let bbox: VisibleRect | null =
    deps.cdp !== undefined && looked.backendDOMNodeId !== undefined
      ? await visibleRect(deps.cdp, looked.backendDOMNodeId)
      : null;
  if (bbox === null) {
    const { hint } = buildSelectorHint(looked);
    bbox = await locatorBoundingBox(deps.page, hint, { timeoutMs: 1000 });
  }
  return markEntryFrom(index, looked, bbox);
}

export async function resolveCandidates(
  deps: MarksDeps,
  candidates: MarkCandidate[],
): Promise<{ entries: MarkEntry[]; warnings: string[] }> {
  const warnings: string[] = [];
  const entries: MarkEntry[] = [];
  // Fast-path: when every candidate already carries a bbox (e.g. piped straight
  // from a prior find()), skip the tree walk entirely.
  const lookupByRef = candidates.every(hasBbox) ? null : await buildRefLookup(deps, warnings);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (hasBbox(c)) {
      entries.push(markEntryFrom(i + 1, c, c.bbox));
    } else {
      entries.push(await resolveBareRef(deps, i + 1, c.ref, lookupByRef, warnings));
    }
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
