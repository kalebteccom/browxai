// The ios-app engine's target parser — the agent-facing `selector` vocabulary
// turned into a predicate over hierarchy nodes.
//
// It reads the SAME four shapes `buildSelectorHint` emits, so a hint an agent
// copies out of `find` resolves through `click` unchanged:
//
//   [accessibilityIdentifier="checkout-submit"]   tier 1 — the identifier
//   role=button[name="Pay now"]                   tier 2 — role and label
//   role=button                                   tier 5 — role only
//   checkout-submit                               bare — identifier, else label
//
// Two aliases are accepted because they are what the surrounding ecosystem
// writes: `~checkout-submit` is Appium's accessibility-id shorthand (RFC 0008 §3
// proposes it as browxai's hint form; the attribute-named form ships instead
// because it says WHICH attribute was queried, and both resolve), and
// `[testID="…"]` is what a React Native author calls the prop that compiles to
// the identifier.
//
// A name match is EXACT. `getByRole`'s substring semantics would make
// `[name="Pay"]` match "Pay now" and "Payment method" alike, and on a surface
// whose whole purpose is evidence, an action against the wrong element is worse
// than a failed action. The substring form is available as a `find` query, which
// ranks rather than acts.

import type { NativeNode } from "../engine/native-types.js";
import { roleForType } from "./ios-hierarchy.js";

/** A predicate over one hierarchy node, plus the human-readable form of the
 *  query that built it — the refusal text names the latter. */
export interface NativeMatcher {
  readonly describe: string;
  matches(node: NativeNode): boolean;
}

/** The selector did not parse into anything this engine can query. */
export class UnparseableSelectorError extends Error {
  constructor(selector: string) {
    super(
      `unaddressable-target: "${selector}" is not a selector the ios-app engine can query. ` +
        'Use [accessibilityIdentifier="…"] (the testID), role=<role>[name="…"], role=<role>, or a ' +
        "bare string matched against the identifier then the label.",
    );
    this.name = "UnparseableSelectorError";
  }
}

const ATTRIBUTE = /^\[\s*([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]$/;
const ROLE_WITH_NAME = /^role=([\w-]+)\[name=(?:"([^"]*)"|'([^']*)')\]$/;
const ROLE_ONLY = /^role=([\w-]+)$/;

/** Attribute names that all mean "the accessibility identifier". */
const IDENTIFIER_ATTRS = new Set(["accessibilityidentifier", "identifier", "testid"]);

export function parseNativeSelector(selector: string): NativeMatcher {
  const raw = selector.trim();
  if (!raw) throw new UnparseableSelectorError(selector);

  if (raw.startsWith("~")) return identifierMatcher(raw.slice(1));

  const attribute = ATTRIBUTE.exec(raw);
  if (attribute) {
    const attr = attribute[1]!.toLowerCase();
    const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    if (IDENTIFIER_ATTRS.has(attr)) return identifierMatcher(value);
    // `name` is the ACCESSIBLE NAME everywhere else in browxai, so it is the
    // label here too — not a second spelling of the identifier.
    if (attr === "label" || attr === "name") return labelMatcher(value);
    if (attr === "value") {
      return { describe: raw, matches: (n) => n.value === value };
    }
    if (attr === "type") {
      return { describe: raw, matches: (n) => n.type === value };
    }
    throw new UnparseableSelectorError(selector);
  }

  const roleName = ROLE_WITH_NAME.exec(raw);
  if (roleName) {
    const role = roleName[1]!;
    const name = roleName[2] ?? roleName[3] ?? "";
    return {
      describe: raw,
      matches: (n) => roleForType(n.type) === role && n.label === name,
    };
  }

  const roleOnly = ROLE_ONLY.exec(raw);
  if (roleOnly) {
    const role = roleOnly[1]!;
    return { describe: raw, matches: (n) => roleForType(n.type) === role };
  }

  // A bare string. The identifier first, because that is the tier-1 selector and
  // an app that labels an element and identifies it differently means the
  // identifier.
  return {
    describe: raw,
    matches: (n) => n.identifier === raw || (n.identifier === undefined && n.label === raw),
  };
}

function identifierMatcher(value: string): NativeMatcher {
  return {
    describe: `[accessibilityIdentifier=${JSON.stringify(value)}]`,
    matches: (n) => n.identifier === value,
  };
}

function labelMatcher(value: string): NativeMatcher {
  return { describe: `[label=${JSON.stringify(value)}]`, matches: (n) => n.label === value };
}
