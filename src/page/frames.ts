// Frame-scoped observation.
//
// Iframes are everywhere on real pages; today's CDP-rooted snapshot/find
// observe only the top frame. This module exposes the page's frame tree to
// agents and, for the consumers in this directory (snapshot/find/action),
// provides stable frame IDs that round-trip back into a Playwright `Frame`
// for scoped reads and ref-resolution.
//
// Frame ID scheme:
//   - The main frame's ID is always `f0` (well-known sentinel — agents
//     can address it explicitly when they want to be unambiguous about
//     "the main frame", though omitting `frame` from snapshot/find keeps
//     the existing main-frame-only behaviour byte-identical for back-compat).
//   - Child frames mint a stable `fN` (N=1..) using a session-local
//     monotonic counter keyed by a structural fingerprint
//     (parent-id + index among siblings + name + url-origin). Same iframe
//     across two `frames_list` calls keeps the same ID.
//
// Cross-origin caveat: Playwright's `Frame` handle works for both
// same-origin and cross-origin iframes — `frame.locator(...)`,
// `frame.evaluate(...)`, and the action surface all transparently cross
// the OOPIF boundary. The one observable gap is the CDP
// `Accessibility.getFullAXTree` path used by main-frame snapshots: per
// frame, the CDP session is rooted at the top target, so child frames
// fall back to the DOM-walk pass only (no a11y nodes from CDP). This is
// surfaced as a warning on frame-scoped snapshots.

import { createHash } from "node:crypto";
import type { Frame, Page } from "playwright-core";

/** Stable sentinel for the page's top-level frame. */
export const MAIN_FRAME_ID = "f0";

export interface FrameInfo {
  /** Stable per-session ID — pass back to snapshot/find/action via `frame`. */
  frameId: string;
  /** Parent frame's ID. Absent for the main frame. */
  parentFrameId?: string;
  url: string;
  /** `<iframe name="…">` or empty when not set. */
  name: string;
  isMainFrame: boolean;
  /** Origin parsed from `url` (`http://example.com`); empty for non-URL
   *  frames (`about:blank`, `data:` URLs). */
  origin: string;
}

/** Per-session cache: structural fingerprint → stable frameId. */
export class FrameRegistry {
  private idByFingerprint = new Map<string, string>();
  private frameByFingerprint = new WeakMap<Frame, string>();
  private counter = 0;

  /** Assign (or look up) a stable ID for `frame`. The main frame always
   *  gets `MAIN_FRAME_ID`. Child frames get `f1`, `f2`, … by first-seen
   *  order; identical-fingerprint frames across calls keep their ID. */
  idFor(frame: Frame, fingerprint: string): string {
    // Per-instance shortcut: a Playwright Frame handle that we've seen this
    // session keeps the same ID — even if its URL changes mid-navigation.
    const cached = this.frameByFingerprint.get(frame);
    if (cached) return cached;
    let id = this.idByFingerprint.get(fingerprint);
    if (!id) {
      id = fingerprint === MAIN_FRAME_FINGERPRINT ? MAIN_FRAME_ID : `f${++this.counter}`;
      this.idByFingerprint.set(fingerprint, id);
    }
    this.frameByFingerprint.set(frame, id);
    return id;
  }

  /** Test/introspection only. */
  size(): number {
    return this.idByFingerprint.size;
  }
}

/** Reserved fingerprint for the main frame. */
const MAIN_FRAME_FINGERPRINT = "__main__";

/** Walk the page's frame tree and emit `FrameInfo[]`, depth-first. The
 *  main frame is always first. */
export function listFrames(page: Page, registry: FrameRegistry): FrameInfo[] {
  const out: FrameInfo[] = [];
  const main = page.mainFrame();
  visitFrame(main, undefined, undefined, registry, out);
  return out;
}

function visitFrame(
  frame: Frame,
  parentFrameId: string | undefined,
  siblingIndex: number | undefined,
  registry: FrameRegistry,
  out: FrameInfo[],
): void {
  const isMain = frame.parentFrame() === null;
  const fingerprint = isMain
    ? MAIN_FRAME_FINGERPRINT
    : fingerprintOf(frame, parentFrameId, siblingIndex ?? 0);
  const frameId = registry.idFor(frame, fingerprint);
  out.push({
    frameId,
    ...(parentFrameId ? { parentFrameId } : {}),
    url: frame.url(),
    name: frame.name(),
    isMainFrame: isMain,
    origin: originOf(frame.url()),
  });
  const children = frame.childFrames();
  for (let i = 0; i < children.length; i++) {
    visitFrame(children[i]!, frameId, i, registry, out);
  }
}

/** Structural fingerprint — short hex hash of the inputs that should keep
 *  a child frame's identity stable across calls within a session. Includes
 *  parent ID + sibling index + name + url origin. Not URL-path-sensitive so
 *  intra-iframe navigation doesn't reset the ID; not name-only so two
 *  identically-named iframes in the same parent still get distinct IDs via
 *  their sibling index. Exported for unit tests. */
export function fingerprintOf(
  frame: Frame,
  parentFrameId: string | undefined,
  siblingIndex: number,
): string {
  const raw = [parentFrameId ?? "", String(siblingIndex), frame.name(), originOf(frame.url())].join(
    "|",
  );
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** Origin of a frame URL — `http://host` or empty for opaque schemes. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "about:" || u.protocol === "data:" || u.protocol === "blob:") {
      return "";
    }
    return u.origin;
  } catch {
    return "";
  }
}

/** Resolve a `frameId` back to a Playwright `Frame` handle. Returns the
 *  main frame for `MAIN_FRAME_ID`; null for an unknown ID. The walk is
 *  cheap (frame trees are small) and avoids needing a reverse Map that
 *  could go stale when a frame is detached. */
export function resolveFrameById(
  page: Page,
  registry: FrameRegistry,
  frameId: string,
): Frame | null {
  if (frameId === MAIN_FRAME_ID) return page.mainFrame();
  return findFrame(page.mainFrame(), undefined, undefined, registry, frameId);
}

function findFrame(
  frame: Frame,
  parentFrameId: string | undefined,
  siblingIndex: number | undefined,
  registry: FrameRegistry,
  target: string,
): Frame | null {
  const isMain = frame.parentFrame() === null;
  const fingerprint = isMain
    ? MAIN_FRAME_FINGERPRINT
    : fingerprintOf(frame, parentFrameId, siblingIndex ?? 0);
  const id = registry.idFor(frame, fingerprint);
  if (id === target) return frame;
  const children = frame.childFrames();
  for (let i = 0; i < children.length; i++) {
    const hit = findFrame(children[i]!, id, i, registry, target);
    if (hit) return hit;
  }
  return null;
}
