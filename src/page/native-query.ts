// The native selector vocabulary and the pure matcher behind it.
//
// TIER 1 IS testID, AND NOTHING ELSE COMPETES (RFC 0008 §3). A query that names a
// testID matches on the testID alone; a query that does not is matched by label,
// then by rendered text, then by role. The tiers are ordered, and a match at a
// higher tier stops the search — so `find`'s selector hint can say which tier it
// queried and an exported step reads `~checkout-submit` rather than a pixel pair.
//
// AMBIGUITY IS A REFUSAL HERE. RFC 0009's `ElementSubstrate` doc says zero or many
// matches is a refusal, and its 2026-09-16 amendment records that web does NOT do
// that: `locatorFromInputs` narrows every tier through `.first()`, so an ambiguous
// web ref silently acts on the first match. The amendment is explicit that a
// native engine, with no legacy to preserve, refuses — and that the silent
// first-match pick is "the same mistap that got mobile-mcp rejected in the owner's
// trial". So this matcher returns ALL matches and the substrate above it refuses
// on a count other than one, naming the ref and the count.
//
// Pure: a parsed query and a composed view in, matches out. No adb, no clock.

import type { A11yNode } from "./a11y-types.js";
import { walk } from "./a11y-types.js";
import type { NativeRefRecipe } from "./native-hierarchy.js";
import type { NativeScreenView } from "./native-screen.js";

/** One matched element: its ref in the current view, the composed node, and the
 *  recipe carrying its bounds. */
export interface NativeMatch {
  ref: string;
  node: A11yNode;
  recipe: NativeRefRecipe;
}

/** Which tier a query addressed, reported so a selector hint says what it
 *  actually queried. */
export type NativeQueryTier = "testid" | "label" | "text" | "role" | "any";

/** A parsed native selector. */
export interface NativeQuery {
  tier: NativeQueryTier;
  value: string;
  /** Set by the `role=button[name="x"]` form. */
  role?: string;
}

/** Parse the agent-facing native selector vocabulary.
 *
 *  - `~value` / `testID=value` / `id=value` — the testID tier. `~` is Appium's
 *    accessibility-id prefix and is carried because it is what a mobile-QA agent
 *    already types.
 *  - `label=value` — the accessibility label.
 *  - `text=value` — the rendered string.
 *  - `role=button[name="Save"]` — role plus label, the shape the web selector
 *    vocabulary already uses.
 *  - anything else — matched across testID, then label, then text, in that order.
 *    The bare form is a convenience and it reports the tier it landed on, so an
 *    agent can see it resolved by label when it expected a testID. */
export function parseNativeQuery(raw: string): NativeQuery {
  const s = raw.trim();
  if (s.startsWith("~")) return { tier: "testid", value: s.slice(1) };
  const roleForm = /^role=([\w-]+)(?:\[name="([^"]*)"])?$/.exec(s);
  if (roleForm) return { tier: "role", value: roleForm[2] ?? "", role: roleForm[1] };
  const prefixed = /^(testID|testid|id|label|text)=(.*)$/s.exec(s);
  if (prefixed) {
    const key = prefixed[1]!.toLowerCase();
    const tier: NativeQueryTier = key === "label" ? "label" : key === "text" ? "text" : "testid";
    return { tier, value: prefixed[2]! };
  }
  return { tier: "any", value: s };
}

/** Every `(ref, node, recipe)` triple in a view, in document order. */
function entries(view: NativeScreenView): NativeMatch[] {
  const out: NativeMatch[] = [];
  for (const { node } of walk(view.root)) {
    const recipe = view.recipes.get(node.ref);
    if (recipe) out.push({ ref: node.ref, node, recipe });
  }
  return out;
}

function eq(a: string | undefined, b: string): boolean {
  return (a ?? "").trim() === b.trim();
}

/** Match a parsed query against a composed view. Returns every match, because
 *  the count is the caller's decision and hiding it is the defect. */
export function matchNativeQuery(view: NativeScreenView, query: NativeQuery): NativeMatch[] {
  const all = entries(view);
  switch (query.tier) {
    case "testid":
      return all.filter((m) => eq(m.node.testId, query.value));
    case "label":
      return all.filter((m) => eq(m.node.name, query.value));
    case "text":
      return all.filter((m) => eq(m.node.text, query.value) || eq(m.node.name, query.value));
    case "role":
      return all.filter(
        (m) => m.node.role === query.role && (!query.value || eq(m.node.name, query.value)),
      );
    case "any":
      return firstNonEmpty(all, query.value);
  }
}

/** The bare-string tiers, in order. The FIRST tier that matches anything wins —
 *  a string that is a real testID must never also drag in every node whose label
 *  happens to read the same. */
function firstNonEmpty(all: NativeMatch[], value: string): NativeMatch[] {
  const byTestId = all.filter((m) => eq(m.node.testId, value));
  if (byTestId.length) return byTestId;
  const byLabel = all.filter((m) => eq(m.node.name, value));
  if (byLabel.length) return byLabel;
  return all.filter((m) => eq(m.node.text, value));
}

/** Re-resolve a ref against a FRESH view, using the recipe it was minted with.
 *
 *  A testID-bearing ref re-resolves by testID and never by its path, which is the
 *  whole point of the native ref rule: the element is allowed to have moved. A
 *  ref without a testID falls back to label plus role, and then to the structural
 *  path it was minted at — that last tier is the snapshot-local case and it is
 *  honestly the weakest, which is why `snapshot` warns when an app is thin on
 *  testIDs. */
export function resolveRecipe(view: NativeScreenView, recipe: NativeRefRecipe): NativeMatch[] {
  const all = entries(view);
  if (recipe.testId) {
    const byTestId = all.filter((m) => eq(m.node.testId, recipe.testId!));
    // Role is a tie-breaker only. A testID that now matches two nodes of
    // different roles is still ambiguous, and the substrate refuses on the count.
    const narrowed = byTestId.filter((m) => m.node.role === recipe.role);
    return narrowed.length === 1 ? narrowed : byTestId;
  }
  if (recipe.name) {
    const byName = all.filter((m) => eq(m.node.name, recipe.name!) && m.node.role === recipe.role);
    if (byName.length) return byName;
  }
  return all.filter((m) => m.recipe.path === recipe.path && m.node.role === recipe.role);
}

/** The selector string an exported step should carry for a node — the tier-1
 *  form when the app labelled the element, and an honest weaker form when it did
 *  not. `~name` is the Appium accessibility-id spelling RFC 0008 §3 names. */
export function nativeSelectorHint(node: A11yNode, recipe: NativeRefRecipe): string {
  if (node.testId) return `~${node.testId}`;
  if (node.name) return `label=${node.name}`;
  if (node.text) return `text=${node.text}`;
  return `role=${recipe.role}`;
}
