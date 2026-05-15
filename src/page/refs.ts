// Stable `eN` ref scheme — the coherence constraint from docs/phase-1-design.md §2.
//
// A ref is assigned by a *stable element key* (a hash of role + accessible name +
// structural path + testid-if-any), NOT by enumeration order. When a node persists
// across snapshots it keeps its eN; new nodes get fresh ones. This is what makes
// `tree_diff` line-stable and what lets refs from a `find()` candidate survive
// the next `snapshot()`.

import { createHash } from "node:crypto";

export interface KeyInputs {
  role: string;
  name?: string;
  /** A structural path through the a11y tree, e.g. "WebArea/main/list/listitem[2]/button". */
  path: string;
  /** Optional test-id-ish attribute value to disambiguate identical roles. */
  testId?: string;
}

export function elementKey(inputs: KeyInputs): string {
  const raw = [inputs.role, inputs.name ?? "", inputs.path, inputs.testId ?? ""].join("");
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
}

export class RefRegistry {
  private refByKey = new Map<string, string>();
  private keyByRef = new Map<string, string>();
  private locatorByRef = new Map<string, RefLocatorInputs>();
  /** Wishlist W-C1: persistent named refs. Maps an agent-chosen mnemonic (e.g.
   *  "play_btn") to the underlying ref. Refs themselves are stable across
   *  snapshots (see elementKey()) so the name effectively pins an element
   *  identity for the whole session. */
  private refByName = new Map<string, string>();
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

  has(ref: string): boolean { return this.keyByRef.has(ref); }
  hasKey(key: string): boolean { return this.refByKey.has(key); }
  keyOf(ref: string): string | undefined { return this.keyByRef.get(ref); }
  locatorOf(ref: string): RefLocatorInputs | undefined { return this.locatorByRef.get(ref); }
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
    };
    this.locatorByRef.set(ref, merged);
  }

  // --- W-C1: named refs ---
  /** Bind a mnemonic name to a ref. Overwrites any prior binding for that name. */
  nameRef(name: string, ref: string): void {
    if (!this.keyByRef.has(ref)) throw new Error(`name_ref: ref "${ref}" not in registry`);
    this.refByName.set(name, ref);
  }
  /** Resolve a name back to a ref. */
  refByNameLookup(name: string): string | undefined { return this.refByName.get(name); }
  /** List all current name → ref bindings. */
  listNames(): Array<{ name: string; ref: string }> {
    return [...this.refByName.entries()].map(([name, ref]) => ({ name, ref }));
  }

  /** Useful for tests / introspection only. */
  size(): number { return this.refByKey.size; }
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
