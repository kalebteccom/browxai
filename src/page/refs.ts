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
}

export class RefRegistry {
  private refByKey = new Map<string, string>();
  private keyByRef = new Map<string, string>();
  private locatorByRef = new Map<string, RefLocatorInputs>();
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
  keyOf(ref: string): string | undefined { return this.keyByRef.get(ref); }
  locatorOf(ref: string): RefLocatorInputs | undefined { return this.locatorByRef.get(ref); }
  updateLocator(ref: string, locator: RefLocatorInputs): void {
    if (this.keyByRef.has(ref)) this.locatorByRef.set(ref, locator);
  }
  /** Useful for tests / introspection only. */
  size(): number { return this.refByKey.size; }
}
