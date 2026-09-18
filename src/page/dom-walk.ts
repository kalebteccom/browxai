// DOM-walk fallback —  .
//
// The 2026-05-13 target-app adoption found that `Accessibility.getFullAXTree` returns
// root-only on heavy SPAs whose markup is mostly `div`s with `data-testid`/`data-type`
// (legacy-React / Reflux). With nothing in the a11y tree, find() degrades to tier-5
// `low` and the curated surface is no better than grep. The fix is to walk the DOM
// directly for interactive / data-attribute-bearing elements when the a11y signal is
// thin, and combine the two sources into the snapshot tree.
//
// Implementation: run a single `Runtime.evaluate` in page context that returns a
// JSON array of { role, name, testId, testIdAttr, tag, id, structuralPath } for
// every visible element matching the interactive predicate set OR carrying any of
// the configured test attributes. Convert to A11yNode (leaf nodes — DOM walk
// doesn't produce children; the a11y tree is the structural source).

import type { CDPSession, Frame } from "playwright-core";
import { elementKey, RefRegistry } from "./refs.js";
import { bindRefFrame } from "./ref-frames.js";
import { walk, isGenericNoise, type A11yNode } from "./a11y-types.js";

export interface DomWalkEntry {
  role: string;
  name: string;
  testId: string;
  testIdAttr: string;
  tag: string;
  /** `href` attribute present. Only meaningful on `<a>` / `<area>`; `false` elsewhere. */
  hasHref?: boolean;
  /** Lowercased `<input type>` (defaulted to "text" when the attribute is absent);
   *  empty for every other tag. */
  inputType?: string;
  id: string;
  structuralPath: string;
  /** Valid CSS selector built from the `:nth-child` chain at walk time.
   *  Used as the locator for refs whose role is a bare tag (`td`, `div`,
   *  generic) where `getByRole` would be ambiguous or wrong. */
  cssPath: string;
}

export interface DomWalkOptions {
  /** Attributes treated as "test ids" (tier-1 selectorHint candidates). */
  testAttributes?: string[];
  /** Hard cap on returned entries (sanity bound; the JS side already caps). */
  maxEntries?: number;
  /** shadow DOM piercing.
   *  - `"open"` (the implicit default — preserves pre-v0.5.0 behaviour;
   *    the page-side walk recurses into every `Element.shadowRoot` it sees,
   *    same as `querySelectorAll` semantics on open roots).
   *  - `"closed"` — additionally invokes the CDP `DOM.getDocument(
   *    {pierce:true})` path and harvests interactive / test-attr-bearing
   *    elements that live inside closed shadow roots. Best-effort; falls
   *    back to open-only when CDP refuses pierce.
   *  - `false` — no shadow recursion. Equivalent to walking only the top
   *    document's children.
   */
  pierce?: "open" | "closed" | false;
}

const DEFAULT_TEST_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa"];
const DEFAULT_MAX = 500;

/**
 * Run the in-page DOM-walk and return the discovered entries.
 *
 * Notes:
 *  - The script runs in page context — keep it ECMAScript-only (no TS).
 *  - Stringified function so we can pass it through `Runtime.evaluate` with
 *    `returnByValue: true`.
 *  - Visibility is checked at walk time (`getBoundingClientRect` non-zero + computed
 *    `visibility !== hidden` + `display !== none`). This intentionally skips offscreen
 *    elements (they wouldn't be clickable from the agent's POV right now).
 */
export async function runDomWalk(
  cdp: CDPSession,
  opts: DomWalkOptions = {},
): Promise<DomWalkEntry[]> {
  const testAttrs = opts.testAttributes ?? DEFAULT_TEST_ATTRS;
  const max = opts.maxEntries ?? DEFAULT_MAX;
  // Back-compat: `pierce: undefined` preserves pre-v0.5.0 behaviour
  // (top-document walk only). `pierce: "open"` / `"closed"` opts into the
  // shadow-aware walk that recurses through every open shadow root we can
  // see from the page side. Closed shadow roots are platform-inaccessible
  // here; the CDP path in src/page/shadow.ts covers them and adds the
  // result via the merge layer.
  const walkOpen = opts.pierce === "open" || opts.pierce === "closed";
  const expr = `(${PAGE_SCRIPT})(${JSON.stringify(testAttrs)}, ${max}, ${walkOpen})`;
  try {
    const { result } = (await cdp.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: false,
    })) as { result: { value?: DomWalkEntry[] } };
    return result.value ?? [];
  } catch {
    return [];
  }
}

/**
 * Frame-scoped DOM walk. Same `PAGE_SCRIPT`, but evaluated inside
 * a Playwright `Frame` via `frame.evaluate(...)` instead of the top-level
 * CDP `Runtime.evaluate`. Works transparently for both same-origin and
 * cross-origin (OOPIF) child frames — Playwright's frame API spans both.
 *
 * Honours `pierce` the same way the top-level walk does: `"open"` / `"closed"`
 * recurses into reachable open shadow roots inside the frame; `false` /
 * undefined sticks to the frame's top document. Closed-shadow CDP harvesting
 * is not run for child frames (the CDP path is rooted at the top target).
 */
export async function runDomWalkOnFrame(
  frame: Frame,
  opts: DomWalkOptions = {},
): Promise<DomWalkEntry[]> {
  const testAttrs = opts.testAttributes ?? DEFAULT_TEST_ATTRS;
  const max = opts.maxEntries ?? DEFAULT_MAX;
  const walkOpen = opts.pierce === "open" || opts.pierce === "closed";
  try {
    const raw = await frame.evaluate(
      ({
        script,
        attrs,
        cap,
        openShadow,
      }: {
        script: string;
        attrs: string[];
        cap: number;
        openShadow: boolean;
      }): DomWalkEntry[] => {
        // The page-side `Function` constructor produces an untyped callable;
        // annotate its precise call signature (the PAGE_SCRIPT IIFE returns
        // `DomWalkEntry[]`) so the invocation result is typed, not `any`.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const run = new Function(
          "attrs",
          "cap",
          "openShadow",
          `return (${script})(attrs, cap, openShadow)`,
        ) as (attrs: string[], cap: number, openShadow: boolean) => DomWalkEntry[];
        return run(attrs, cap, openShadow);
      },
      { script: PAGE_SCRIPT, attrs: testAttrs, cap: max, openShadow: walkOpen },
    );
    return raw ?? [];
  } catch {
    return [];
  }
}

/**
 * Transport-agnostic DOM walk. Runs the SAME `PAGE_SCRIPT` via an injected
 * `exec` that takes a function BODY + an args array and returns the value —
 * exactly the WebDriver-Classic `execute/sync` shape (`{script, args}`). This is
 * the seam the Safari snapshot substrate uses: Safari has neither
 * CDP nor a Playwright Frame, but `safaridriver`'s `execute/sync` runs the script
 * identically (the returned `DomWalkEntry` shape matches
 * `frame.evaluate` byte-for-byte).
 * `PAGE_SCRIPT` stays encapsulated here; callers pass only the transport.
 */
export async function runDomWalkViaExecute(
  exec: (scriptBody: string, args: unknown[]) => Promise<unknown>,
  opts: DomWalkOptions = {},
): Promise<DomWalkEntry[]> {
  const testAttrs = opts.testAttributes ?? DEFAULT_TEST_ATTRS;
  const max = opts.maxEntries ?? DEFAULT_MAX;
  const walkOpen = opts.pierce === "open" || opts.pierce === "closed";
  try {
    const raw = await exec(`return (${PAGE_SCRIPT})(arguments[0], arguments[1], arguments[2])`, [
      testAttrs,
      max,
      walkOpen,
    ]);
    return (raw as DomWalkEntry[]) ?? [];
  } catch {
    return [];
  }
}

/** Build the page-side script. Returned as a stringified IIFE.
 *  `walkOpenShadow` — when true, the DOM-walk additionally recurses into every
 *  `Element.shadowRoot` (open mode) and runs the same predicate-match on its
 *  descendants. Closed shadow roots are platform-protected and unreachable from
 *  the page side; the CDP path in `src/page/shadow.ts` covers them. */
const PAGE_SCRIPT = `function(testAttrs, max, walkOpenShadow) {
  var ATTR_INTERACTIVE_SEL = '[role],button,a[href],input,select,textarea,[onclick],[tabindex],[contenteditable="true"]';
  var attrSel = testAttrs.map(function(a){ return '['+a+']'; }).join(',');
  var sel = ATTR_INTERACTIVE_SEL + (attrSel ? ',' + attrSel : '');
  // Collect matches from the top document AND, when walkOpenShadow is set,
  // from every open shadow root we can reach. querySelectorAll does NOT
  // pierce shadow boundaries by web-platform design, so we walk shadow
  // roots explicitly.
  var els = Array.prototype.slice.call(document.querySelectorAll(sel));
  if (walkOpenShadow) {
    var shadowHosts = [];
    function collectHosts(root) {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var sr = all[i].shadowRoot;
        if (sr) shadowHosts.push(sr);
      }
    }
    collectHosts(document);
    var seen = 0;
    while (shadowHosts.length > seen) {
      var sr2 = shadowHosts[seen++];
      var matches = sr2.querySelectorAll(sel);
      for (var j = 0; j < matches.length; j++) els.push(matches[j]);
      collectHosts(sr2);
      // Hard bound — a pathological page could embed thousands of nested
      // shadow roots; cap the walk to keep snapshot latency predictable.
      if (seen > 500) break;
    }
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function structuralPath(el) {
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && n.tagName !== 'HTML') {
      var tag = n.tagName.toLowerCase();
      var role = n.getAttribute('role') || '';
      var parent = n.parentElement;
      var idx = parent ? Array.prototype.indexOf.call(parent.children, n) : 0;
      parts.unshift(tag + (role ? '@' + role : '') + '[' + idx + ']');
      n = parent;
    }
    return parts.join('/');
  }
  function cssPath(el) {
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && n.tagName !== 'HTML') {
      var tag = n.tagName.toLowerCase();
      var parent = n.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var idx = Array.prototype.indexOf.call(parent.children, n) + 1;
      parts.unshift(tag + ':nth-child(' + idx + ')');
      n = parent;
    }
    return parts.join(' > ');
  }
  function nameFor(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 120);
    var lid = el.getAttribute('aria-labelledby');
    if (lid) {
      var parts = lid.split(/\\s+/).map(function(id){ var n = document.getElementById(id); return n ? (n.textContent || '') : ''; });
      var s = parts.join(' ').trim();
      if (s) return s.slice(0, 120);
    }
    if (el.tagName === 'INPUT') {
      if (el.placeholder) return el.placeholder.trim().slice(0, 120);
      if (el.value && el.type !== 'password') return String(el.value).trim().slice(0, 120);
    }
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text && text.length <= 120) return text;
    // title attribute as last-resort label source. Icon-only buttons
    // commonly carry their visible label here when neither aria-label nor
    // textContent (the icon's empty span) is set.
    var title = el.getAttribute('title');
    if (title) return title.trim().slice(0, 120);
    return '';
  }
  function testIdFor(el) {
    for (var i = 0; i < testAttrs.length; i++) {
      var a = testAttrs[i];
      var v = el.getAttribute(a);
      if (v) return { attr: a, value: v };
    }
    return null;
  }
  var out = [];
  for (var i = 0; i < els.length && out.length < max; i++) {
    var el = els[i];
    if (!isVisible(el)) continue;
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || tag;
    var tid = testIdFor(el);
    out.push({
      role: role,
      name: nameFor(el),
      testId: tid ? tid.value : '',
      testIdAttr: tid ? tid.attr : '',
      tag: tag,
      hasHref: el.hasAttribute('href'),
      inputType: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '',
      id: el.id || '',
      structuralPath: structuralPath(el),
      cssPath: cssPath(el)
    });
  }
  return out;
}`;

export interface MergeOptions {
  /** when set, refs minted here are namespaced to this frame
   *  (via `elementKey`'s `frameId`) so two iframes with identical markup
   *  don't collide on the same ref. */
  frameId?: string;
  /** when set, refs minted here are bound to this Frame on the
   *  registry so action-time `locatorFor` routes through `frame.locator(...)`
   *  instead of `page.locator(...)`. */
  frame?: Frame;
  /** The backend node id of the element an entry describes, or `undefined`
   *  when no exact identity is available for it. `undefined` appends the entry
   *  as its own node — the pre-dedup behaviour — so an uncertain identity
   *  costs a duplicate and never a wrong merge. */
  identify?: (entry: DomWalkEntry) => number | undefined;
}

/**
 * Fold the DOM-walk entries into `root`, minting refs through the same
 * `RefRegistry` so the IDs are stable across snapshots.
 *
 * An entry the a11y tier already has in this tree is folded into the node the
 * a11y tier minted — one element, one ref, `source: "both"` — and that node
 * picks up the facts only the walk has. An entry the a11y tier does not have is
 * appended as its own leaf, which is the DOM walk's whole reason to exist.
 *
 * Returns `{ added, combined }` for THIS snapshot: `added` counts entries the
 * a11y tier did not already have, `combined` counts entries it did.
 * `stats.tier` and the low-content warning both read `added`, so the count has
 * to describe the snapshot in hand, not the session's history.
 *
 * Whether the two tiers can recognise each other at all is `opts.identify`'s
 * answer. Their ref keys cannot: the a11y tier keys on the ARIA role and the
 * accessibility-tree path, the DOM walk on the bare tag and the DOM path, so
 * the same `<a>` is `link` at one key and `a` at another and no entry ever
 * matched — which is why Hacker News reported its 228 anchors twice.
 * `identify` supplies the shared identity instead: the backend node id, which
 * the a11y tier carries on every node. Only the CDP composer can build one (see
 * `dom-index.ts`). The frame, Safari and off-Chromium composers pass none and
 * every entry is appended, exactly as before — none of the three runs an a11y
 * tier, so an entry there has nothing to duplicate.
 */
export function mergeDomWalkIntoTree(
  root: A11yNode,
  entries: DomWalkEntry[],
  refs: RefRegistry,
  opts: MergeOptions = {},
): { added: number; combined: number } {
  let added = 0;
  let combined = 0;
  const { frameId, frame, identify } = opts;
  const targets = identify ? mergeTargets(root) : undefined;
  for (const e of entries) {
    const target = targets && identify ? lookupTarget(targets, identify(e)) : undefined;
    if (target) {
      // One a11y node absorbs at most one entry. Two entries claiming the same
      // element would mean the walk reported it twice, and the second is not
      // evidence about this node.
      targets!.delete(target.backendDOMNodeId!);
      absorbDomEntry(target, e, refs, frameId);
      combined++;
      continue;
    }
    root.children.push(domEntryNode(e, refs, frameId, frame));
    added++;
  }
  return { added, combined };
}

function lookupTarget(
  targets: Map<number, A11yNode>,
  backendNodeId: number | undefined,
): A11yNode | undefined {
  return backendNodeId === undefined ? undefined : targets.get(backendNodeId);
}

/**
 * The a11y nodes a DOM-walk entry may be folded into, by backend node id.
 *
 * Two exclusions. A backend node id two a11y nodes claim is dropped: Chromium
 * can expose one DOM element as several AX nodes, and there is no telling which
 * of them the walk saw. A node the serialiser emits no line for is dropped too
 * — folding an entry into one would take the entry's own line out of the
 * snapshot, so an element an agent can act on would disappear instead of
 * deduplicating. Measured across six real pages, that second case is 3 entries
 * of 1,271.
 */
function mergeTargets(root: A11yNode): Map<number, A11yNode> {
  const byBackendId = new Map<number, A11yNode>();
  const claimedTwice = new Set<number>();
  for (const { node } of walk(root)) {
    const bid = node.backendDOMNodeId;
    if (bid === undefined || isGenericNoise(node)) continue;
    if (byBackendId.has(bid)) claimedTwice.add(bid);
    else byBackendId.set(bid, node);
  }
  for (const bid of claimedTwice) byBackendId.delete(bid);
  return byBackendId;
}

/**
 * Fold one entry into the a11y node for the same element.
 *
 * The a11y tier's own findings stand: its ARIA role, its accessible name and
 * its ref. The ref especially — it is the handle a caller may already hold, and
 * the walk's key for the same element is a different string. What the walk adds
 * is what the a11y tier has no way to see: the tag, the resolvable
 * `:nth-child` path, the `href` and `input type` role discriminators, the `id`,
 * and the test attribute on the roles `enrichTestIds` does not cover.
 *
 * The test attribute lands on the NODE and not in the ref's locator recipe.
 * `enrichTestIds` deliberately gives a registry-level `[data-testid=…]` locator
 * only to the interactive and structural roles, and widening that here would
 * demote a precise role+name locator to a `[data-testid=…]` shared across every
 * cell of a table. The snapshot line still shows the attribute, and `find`
 * still ranks and disambiguates on it.
 */
function absorbDomEntry(
  node: A11yNode,
  e: DomWalkEntry,
  refs: RefRegistry,
  frameId?: string,
): void {
  node.source = "both";
  node.tag = e.tag;
  if (e.cssPath) node.cssPath = e.cssPath;
  if (e.hasHref !== undefined) node.hasHref = e.hasHref;
  if (e.inputType) node.inputType = e.inputType;
  if (!node.id && e.id) node.id = e.id;
  if (!node.testId && e.testId) {
    node.testId = e.testId;
    node.testIdAttr = e.testIdAttr || undefined;
  }
  refs.augmentLocator(node.ref, {
    role: node.role,
    name: node.name,
    cssPath: e.cssPath,
    source: "dom",
    ...(frameId ? { frameId } : {}),
  });
}

/** The leaf for an entry no a11y node claims, with its ref minted. */
function domEntryNode(
  e: DomWalkEntry,
  refs: RefRegistry,
  frameId?: string,
  frame?: Frame,
): A11yNode {
  const name = e.name || undefined;
  const testId = e.testId || undefined;
  const testIdAttr = e.testIdAttr || undefined;
  const key = elementKey({ role: e.role, name, path: e.structuralPath, testId, frameId });
  const ref = refs.forKey(key);
  refs.augmentLocator(ref, {
    role: e.role,
    name,
    testId,
    testIdAttr,
    cssPath: e.cssPath,
    source: "dom",
    ...(frameId ? { frameId } : {}),
  });
  if (frame) bindRefFrame(refs, ref, frame);
  return {
    ref,
    role: e.role,
    name,
    testId,
    testIdAttr,
    tag: e.tag,
    ...(e.hasHref !== undefined ? { hasHref: e.hasHref } : {}),
    ...(e.inputType ? { inputType: e.inputType } : {}),
    id: e.id || undefined,
    cssPath: e.cssPath || undefined,
    source: "dom",
    children: [],
  };
}
