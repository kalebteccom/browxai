// Scoped DOM diff around an action (W-Q9) — the `unstable` lane.
//
// For selection-heavy UIs (timeline editors, kanban, custom toggles) the
// state change an agent must verify — "which clip became selected" — is
// expressed only as class / `aria-*` / `data-*` / inline-style changes, not
// visible text or accessibility-tree changes that snapshot/find would catch.
// `act_and_diff` captures a structural DOM map before and after one action
// and reports exactly which elements changed which of those fields.

import type { Page } from "playwright-core";

export interface DomNode {
  tag: string;
  testId?: string;
  classes: string;
  style: string;
  attrs: Record<string, string>; // aria-* and data-* only
}
/** keyed by a structural index path from the scope root, e.g. "0/2/1". */
export type DomMap = Record<string, DomNode>;

const MAX_NODES = 3000;

// Fixed in-page snapshot — no agent JS. Walks the scope subtree, recording
// each element's class/style and only its aria-*/data-* attributes (the
// fields selection state hides in), keyed by structural index path.
//
// `page.evaluate(string)` treats the string as an *expression* (a
// `function(arg){…}` string is never called, args ignored) — so this is an
// arg-less IIFE with the scope selector interpolated as a JSON string literal.
function buildSnapScript(scopeSelector: string | null): string {
  return `(() => {
  var scopeSel = ${JSON.stringify(scopeSelector)};
  var root = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!root) return null;
  var out = {};
  var count = 0;
  function walk(el, path) {
    if (count >= ${MAX_NODES}) return;
    count++;
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('aria-') === 0 || a.name.indexOf('data-') === 0) attrs[a.name] = a.value;
    }
    out[path] = {
      tag: el.tagName.toLowerCase(),
      testId: el.getAttribute('data-testid') || undefined,
      classes: el.getAttribute('class') || '',
      style: el.getAttribute('style') || '',
      attrs: attrs,
    };
    var k = 0;
    for (var c = 0; c < el.children.length; c++) walk(el.children[c], path + '/' + (k++));
  }
  walk(root, '0');
  return out;
})()`;
}

export async function captureDomMap(page: Page, scopeSelector?: string): Promise<DomMap | null> {
  return (await page.evaluate(buildSnapScript(scopeSelector ?? null))) as DomMap | null;
}

export interface DomChange {
  path: string;
  tag: string;
  testId?: string;
  classDelta?: { added: string[]; removed: string[] };
  styleDelta?: { before: string; after: string };
  attrDelta?: Record<string, { before?: string; after?: string }>;
}
export interface DomDiff {
  changed: DomChange[];
  added: Array<{ path: string; tag: string; testId?: string }>;
  removed: Array<{ path: string; tag: string; testId?: string }>;
  counts: { changed: number; added: number; removed: number };
  note?: string;
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

/** Pure structural diff of two DOM maps. Exported for unit tests. */
export function diffDomMaps(before: DomMap | null, after: DomMap | null): DomDiff {
  const changed: DomChange[] = [];
  const added: DomDiff["added"] = [];
  const removed: DomDiff["removed"] = [];
  if (!before || !after) {
    return {
      changed, added, removed,
      counts: { changed: 0, added: 0, removed: 0 },
      note: "scope did not resolve before and/or after the action — pass a `scope` selector that exists across the transition",
    };
  }
  for (const [path, b] of Object.entries(before)) {
    const a = after[path];
    if (!a) {
      removed.push({ path, tag: b.tag, ...(b.testId ? { testId: b.testId } : {}) });
      continue;
    }
    const change: DomChange = { path, tag: a.tag, ...(a.testId ? { testId: a.testId } : {}) };
    let dirty = false;
    if (b.classes !== a.classes) {
      const bt = tokens(b.classes), at = tokens(a.classes);
      change.classDelta = {
        added: [...at].filter((t) => !bt.has(t)),
        removed: [...bt].filter((t) => !at.has(t)),
      };
      dirty = true;
    }
    if (b.style !== a.style) {
      change.styleDelta = { before: b.style, after: a.style };
      dirty = true;
    }
    const attrKeys = new Set([...Object.keys(b.attrs), ...Object.keys(a.attrs)]);
    const attrDelta: Record<string, { before?: string; after?: string }> = {};
    for (const k of attrKeys) {
      if (b.attrs[k] !== a.attrs[k]) attrDelta[k] = { before: b.attrs[k], after: a.attrs[k] };
    }
    if (Object.keys(attrDelta).length) {
      change.attrDelta = attrDelta;
      dirty = true;
    }
    if (dirty) changed.push(change);
  }
  for (const [path, a] of Object.entries(after)) {
    if (!before[path]) added.push({ path, tag: a.tag, ...(a.testId ? { testId: a.testId } : {}) });
  }
  return {
    changed, added, removed,
    counts: { changed: changed.length, added: added.length, removed: removed.length },
  };
}
