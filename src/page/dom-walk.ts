// DOM-walk fallback — Phase-1.5 .
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
import type { A11yNode } from "./a11y.js";

export interface DomWalkEntry {
  role: string;
  name: string;
  testId: string;
  testIdAttr: string;
  tag: string;
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
  /** Phase 7 — shadow DOM piercing.
   *  - `"open"` (the implicit default — preserves pre-Phase-7 behaviour;
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
  // Back-compat: `pierce: undefined` preserves pre-Phase-7 behaviour
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
 * Frame-scoped DOM walk (Phase-7). Same `PAGE_SCRIPT`, but evaluated inside
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await frame.evaluate(
      ({ script, attrs, cap, openShadow }: { script: string; attrs: string[]; cap: number; openShadow: boolean }) =>
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        (new Function("attrs", "cap", "openShadow", `return (${script})(attrs, cap, openShadow)`))(attrs, cap, openShadow),
      { script: PAGE_SCRIPT, attrs: testAttrs, cap: max, openShadow: walkOpen },
    );
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
      id: el.id || '',
      structuralPath: structuralPath(el),
      cssPath: cssPath(el)
    });
  }
  return out;
}`;

/**
 * Convert DOM-walk entries to A11yNode leaves and add them as children of `root`,
 * minting refs through the same `RefRegistry` so the IDs are stable across snapshots
 * (and round-trip with the a11y nodes' refs when both paths see the same element).
 *
 * Returns the count of *new* nodes added (i.e. nodes whose stable key wasn't already
 * present in the registry) so the caller can emit a low-content warning.
 */
export interface MergeOptions {
  /** Phase-7: when set, refs minted here are namespaced to this frame
   *  (via `elementKey`'s `frameId`) so two iframes with identical markup
   *  don't collide on the same ref. */
  frameId?: string;
  /** Phase-7: when set, refs minted here are bound to this Frame on the
   *  registry so action-time `locatorFor` routes through `frame.locator(...)`
   *  instead of `page.locator(...)`. */
  frame?: Frame;
}

export function mergeDomWalkIntoTree(
  root: A11yNode,
  entries: DomWalkEntry[],
  refs: RefRegistry,
  opts: MergeOptions = {},
): { added: number; combined: number } {
  let added = 0;
  let combined = 0;
  const { frameId, frame } = opts;
  for (const e of entries) {
    const name = e.name || undefined;
    const testId = e.testId || undefined;
    const testIdAttr = e.testIdAttr || undefined;
    const key = elementKey({ role: e.role, name, path: e.structuralPath, testId, frameId });
    const wasNew = !refs.hasKey(key);
    const ref = refs.forKey(key);
    refs.augmentLocator(ref, {
      role: e.role,
      name,
      testId,
      testIdAttr,
      cssPath: e.cssPath,
      source: wasNew ? "dom" : "both",
      ...(frameId ? { frameId } : {}),
    });
    if (frame) refs.bindFrame(ref, frame);
    const node: A11yNode = {
      ref,
      role: e.role,
      name,
      testId,
      testIdAttr,
      tag: e.tag,
      id: e.id || undefined,
      source: wasNew ? "dom" : "both",
      children: [],
    };
    root.children.push(node);
    if (wasNew) added++;
    else combined++;
  }
  return { added, combined };
}
