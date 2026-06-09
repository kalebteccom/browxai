// Stable `eN` ref scheme — the cross-snapshot coherence constraint.
//
// A ref is assigned by a *stable element key* (a hash of role + accessible name +
// structural path + testid-if-any), NOT by enumeration order. When a node persists
// across snapshots it keeps its eN; new nodes get fresh ones. This is what makes
// `tree_diff` line-stable and what lets refs from a `find()` candidate survive
// the next `snapshot()`.

import { createHash } from "node:crypto";
import type { Frame } from "playwright-core";

export interface KeyInputs {
  role: string;
  name?: string;
  /** A structural path through the a11y tree, e.g. "WebArea/main/list/listitem[2]/button". */
  path: string;
  /** Optional test-id-ish attribute value to disambiguate identical roles. */
  testId?: string;
  /** Phase-7: stable frame ID this node lives in. Namespaces the key so two
   *  iframes with the same internal markup don't collide on the same ref.
   *  Absent / empty means the main frame, preserving the pre-Phase-7 hash. */
  frameId?: string;
}

export function elementKey(inputs: KeyInputs): string {
  const raw = [
    inputs.role,
    inputs.name ?? "",
    inputs.path,
    inputs.testId ?? "",
    inputs.frameId ?? "",
  ].join("");
  // Short hash — collision-resistant within a single page session.
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** What we remember about a ref so an action can rebuild a Playwright Locator for it. */
export interface RefLocatorInputs {
  role: string;
  name?: string;
  testId?: string;
  /** Attribute *name* that yielded `testId` (e.g. "data-testid", "data-type").
   *  Locator-resolution uses it to build `[<attr>=...]` so non-standard test attributes
   *  Just Work. */
  testIdAttr?: string;
  /** Ref provenance. Drives locator routing: a11y refs use role/name locators
   *  (auto-wait + strict semantics); dom refs use the structural CSS path that
   *  built the ref (refs whose role is a bare tag like `td`/`div`/`generic`
   *  produce ambiguous role-locators that don't actually find anything). `both`
   *  means the same element was discovered by both passes — a11y-tier locators
   *  win, with cssPath available as fallback. */
  source?: "a11y" | "dom" | "both";
  /** Structural CSS path captured at DOM-walk time, e.g.
   *  `body > div:nth-child(2) > table > tbody > tr:nth-child(4) > td:nth-child(3)`.
   *  Used when role/name locators would be ambiguous. Only populated for refs
   *  whose `source` includes `dom`. */
  cssPath?: string;
  /** Phase-7: stable frame ID the ref was minted in. Absent / `f0` means the
   *  main frame (existing behaviour). Anything else: a child iframe — locator
   *  resolution routes through `frame.locator(...)` instead of `page.locator(...)`
   *  so subsequent actions land inside the correct frame. Same-origin and
   *  cross-origin frames work transparently through Playwright's frame API. */
  frameId?: string;
}

export class RefRegistry {
  private refByKey = new Map<string, string>();
  private keyByRef = new Map<string, string>();
  private locatorByRef = new Map<string, RefLocatorInputs>();
  /** persistent named refs. Maps an agent-chosen mnemonic (e.g.
   *  "play_btn") to the underlying ref. Refs themselves are stable across
   *  snapshots (see elementKey()) so the name effectively pins an element
   *  identity for the whole session. */
  private refByName = new Map<string, string>();
  /** Phase-7: Frame handle owning each child-frame ref. Main-frame refs
   *  omit the entry — the page-level locator resolution handles them
   *  unchanged. When a child-frame ref is acted on, `locatorFor` uses
   *  this Frame handle (instead of `page.locator(...)`) so the action
   *  lands inside the right OOPIF / same-origin iframe. */
  private frameByRef = new Map<string, Frame>();
  private counter = 0;

  /** Resolve (or mint) the ref for a node's stable key. */
  forKey(key: string, locator?: RefLocatorInputs): string {
    let ref = this.refByKey.get(key);
    if (!ref) {
      ref = `e${++this.counter}`;
      this.refByKey.set(key, ref);
      this.keyByRef.set(ref, key);
    }
    if (locator) this.locatorByRef.set(ref, locator);
    return ref;
  }

  has(ref: string): boolean {
    return this.keyByRef.has(ref);
  }
  hasKey(key: string): boolean {
    return this.refByKey.has(key);
  }
  keyOf(ref: string): string | undefined {
    return this.keyByRef.get(ref);
  }
  locatorOf(ref: string): RefLocatorInputs | undefined {
    return this.locatorByRef.get(ref);
  }
  updateLocator(ref: string, locator: RefLocatorInputs): void {
    if (this.keyByRef.has(ref)) this.locatorByRef.set(ref, locator);
  }

  /**
   * Merge new locator inputs into an existing ref's record. Existing richness
   * wins (a11y-discovered `name` survives); missing fields fill in from the
   * partial; `source` combines (`a11y` + `dom` → `both`). When the ref has
   * no prior locator inputs, the partial is installed wholesale provided
   * `role` is present.
   */
  augmentLocator(ref: string, partial: Partial<RefLocatorInputs>): void {
    if (!this.keyByRef.has(ref)) return;
    const existing = this.locatorByRef.get(ref);
    if (!existing) {
      if (partial.role !== undefined) this.locatorByRef.set(ref, partial as RefLocatorInputs);
      return;
    }
    const merged: RefLocatorInputs = {
      role: existing.role,
      name: existing.name ?? partial.name,
      testId: existing.testId ?? partial.testId,
      testIdAttr: existing.testIdAttr ?? partial.testIdAttr,
      cssPath: existing.cssPath ?? partial.cssPath,
      source: combineSource(existing.source, partial.source),
      frameId: existing.frameId ?? partial.frameId,
    };
    this.locatorByRef.set(ref, merged);
  }

  // --- frame binding (Phase-7) ---
  /** Bind a Playwright Frame handle to a ref. Call when minting a ref in a
   *  child-frame snapshot/find so action-time `locatorFor` can route through
   *  the frame instead of the page. Main-frame refs don't need to call this;
   *  absence of a binding means "resolve through the page". */
  bindFrame(ref: string, frame: Frame): void {
    if (!this.keyByRef.has(ref)) return;
    this.frameByRef.set(ref, frame);
  }
  /** Resolve a ref to its bound Frame, or undefined for main-frame refs. */
  frameOf(ref: string): Frame | undefined {
    return this.frameByRef.get(ref);
  }

  // --- named refs ---
  /** Bind a mnemonic name to a ref. Overwrites any prior binding for that name. */
  nameRef(name: string, ref: string): void {
    if (!this.keyByRef.has(ref)) throw new Error(`name_ref: ref "${ref}" not in registry`);
    this.refByName.set(name, ref);
  }
  /** Resolve a name back to a ref. */
  refByNameLookup(name: string): string | undefined {
    return this.refByName.get(name);
  }
  /** List all current name → ref bindings. */
  listNames(): Array<{ name: string; ref: string }> {
    return [...this.refByName.entries()].map(([name, ref]) => ({ name, ref }));
  }

  /** Useful for tests / introspection only. */
  size(): number {
    return this.refByKey.size;
  }
}

function combineSource(
  a: RefLocatorInputs["source"] | undefined,
  b: RefLocatorInputs["source"] | undefined,
): RefLocatorInputs["source"] | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  // Any mix of a11y + dom (or already-both) ⇒ both.
  return "both";
}
