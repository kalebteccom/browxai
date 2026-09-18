// `IosElementSubstrate` — resolution, measurement and reading of one element on
// the ios-app engine, and the file where RFC 0008 §3's re-resolution rule is
// actually enforced.
//
// EVERY READ TAKES A FRESH HIERARCHY. `bounds`, `probe` and `count` each call
// `driver.hierarchy()` and re-derive the match; nothing is carried between calls.
// `ElementToken` is plain data — the query and its scope — because RFC 0009 P2
// made it so precisely for this: a cached handle is the mechanism by which the
// owner's trial saw a tap reported against the element that had moved into the
// old rectangle.
//
// A REF RE-RESOLVES BY KEY, NOT BY PATH. The registry holds the `elementKey` a ref
// was minted from; re-resolution recomputes that key for every node in the fresh
// dump and matches on it. That is what makes the identifier rule work end to end:
// an identified node's key omits its path, so the same node at a new position
// still hashes to the same key and the ref resolves; an unidentified node's key
// includes its path, so a node that moved hashes differently and the ref is
// reported STALE rather than silently resolving to its neighbour.
//
// AMBIGUITY REFUSES. The Playwright adapter resolves every tier through `.first()`
// and `element-substrate-types.ts` says so — a shipped behaviour a refactor may
// not flip. A native engine has no such legacy, and RFC 0008 §3 asks for the
// refusal by name: zero or more than one match is structured, and it names the
// query and the count.
//
// Dependency direction (architecture doctrine §1): tool handler → ElementSubstrate
// (the port in `element-substrate-types.ts`) → this implementation → the native
// driver. This file never imports back from the `element-substrate.js` barrel.

import type { NativeNode, NativeSessionHandle } from "../engine/native-types.js";
import type {
  ElementBoundsResult,
  ElementCountResult,
  ElementProbeRequest,
  ElementProbeResult,
  ElementQuery,
  ElementReading,
  ElementRefusal,
  ElementResolution,
  ElementScope,
  ElementSubstrate,
  ElementToken,
} from "./element-substrate-types.js";
import { walkNative } from "./ios-hierarchy.js";
import { parseNativeSelector, UnparseableSelectorError } from "./ios-selector.js";
import type { RefRegistry } from "./refs.js";

const RESNAP = "Call snapshot() or find() again to re-read the screen and mint fresh refs.";

export class IosElementSubstrate implements ElementSubstrate {
  readonly engine = "ios-app";

  constructor(
    private readonly handle: NativeSessionHandle,
    private readonly refs: RefRegistry,
  ) {}

  /** Validate the query and mint the recipe. Touches the device only for a `ref`
   *  the registry does not hold, which needs no device at all — matching the
   *  Playwright adapter, where `resolve` builds a `Locator` and pays for no round
   *  trip. The match COUNT is a `probe` concern. */
  async resolve(query: ElementQuery, scope?: ElementScope): Promise<ElementResolution> {
    if (query.kind === "ref" && !this.refs.has(query.ref)) {
      return {
        kind: "refusal",
        reason: "no-such-element",
        error: `ref "${query.ref}" is not in this session's registry`,
        hint: RESNAP,
        ref: query.ref,
      };
    }
    if (query.kind !== "ref") {
      const text = query.kind === "selector" ? query.selector : query.expression;
      try {
        parseNativeSelector(text);
      } catch (err) {
        return {
          kind: "refusal",
          reason: "unaddressable-target",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { kind: "element", el: { __brand: "element", query, ...(scope ? { scope } : {}) } };
  }

  async bounds(el: ElementToken): Promise<ElementBoundsResult> {
    const found = await this.matchOne(el.query);
    if ("kind" in found && found.kind === "refusal") return found;
    const node = (found as { node: NativeNode }).node;
    // A zero-area frame is a real answer — an off-screen or collapsed element —
    // and `rect: null` is the port's word for "no rendered box".
    const rect = node.rect;
    return {
      kind: "bounds",
      rect: rect.width === 0 && rect.height === 0 ? null : { ...rect },
    };
  }

  async probe(el: ElementToken, want: ElementProbeRequest): Promise<ElementProbeResult> {
    const tree = await this.handle.driver.hierarchy();
    const hits = this.collect(tree, el.query);
    if ("kind" in hits) return hits;
    // `matches` is the one reading that survives an ambiguous query — it is the
    // answer to "how many", so refusing it would be refusing the question.
    if (want.matches !== undefined && hits.length !== 1) {
      return { kind: "reading", matches: hits.length };
    }
    const node = hits[0];
    if (!node) return this.missing(el.query, 0);
    if (hits.length > 1) return this.missing(el.query, hits.length);
    return readingFor(node, want);
  }

  async count(query: ElementQuery): Promise<ElementCountResult> {
    const tree = await this.handle.driver.hierarchy();
    const hits = this.collect(tree, query);
    if ("kind" in hits) return hits;
    return { kind: "count", n: hits.length };
  }

  /** Exactly one node, or the refusal naming why not. */
  private async matchOne(query: ElementQuery): Promise<{ node: NativeNode } | ElementRefusal> {
    const tree = await this.handle.driver.hierarchy();
    const hits = this.collect(tree, query);
    if ("kind" in hits) return hits;
    if (hits.length !== 1) return this.missing(query, hits.length);
    return { node: hits[0]! };
  }

  /** Every node the query matches in THIS dump, or a refusal when the query
   *  itself cannot be made. Exported behaviour, not a helper detail: the action
   *  substrate calls it through `matchOne` before every dispatch. */
  private collect(tree: NativeNode, query: ElementQuery): NativeNode[] | ElementRefusal {
    if (query.kind === "ref") {
      const key = this.refs.keyOf(query.ref);
      if (!key) {
        return {
          kind: "refusal",
          reason: "no-such-element",
          error: `ref "${query.ref}" is not in this session's registry`,
          hint: RESNAP,
          ref: query.ref,
        };
      }
      return [...walkNative(tree)].filter((e) => e.key === key).map((e) => e.node);
    }
    const text = query.kind === "selector" ? query.selector : query.expression;
    try {
      const matcher = parseNativeSelector(text);
      return [...walkNative(tree)].filter((e) => matcher.matches(e.node)).map((e) => e.node);
    } catch (err) {
      if (err instanceof UnparseableSelectorError) {
        return { kind: "refusal", reason: "unaddressable-target", error: err.message };
      }
      throw err;
    }
  }

  /** Zero or many. Both are refusals here and both name the count, which is what
   *  lets an agent tell "it went away" from "the query was too loose". */
  private missing(query: ElementQuery, n: number): ElementRefusal {
    const named =
      query.kind === "ref"
        ? `ref "${query.ref}"`
        : `selector "${query.kind === "selector" ? query.selector : query.expression}"`;
    if (n === 0) {
      return {
        kind: "refusal",
        reason: "stale-element",
        error: `${named} matches no element in the current XCUITest hierarchy`,
        hint:
          query.kind === "ref"
            ? `${RESNAP} A ref whose element carries no accessibility identifier is snapshot-local ` +
              "by construction: it is keyed on its position in the hierarchy, so a layout change " +
              "retires it. Add a `testID` in the app for a ref that survives one."
            : RESNAP,
        ...(query.kind === "ref" ? { ref: query.ref } : {}),
      };
    }
    return {
      kind: "refusal",
      reason: "unaddressable-target",
      error: `${named} matches ${n} elements — the ios-app engine refuses an ambiguous target rather than acting on the first match`,
      hint:
        "Narrow the query: an accessibility identifier is unique per screen in a well-labelled " +
        "app. Acting on the first of several matches is how a tap gets reported against the " +
        "wrong element, which is the failure RFC 0008 §3 exists to prevent.",
      ...(query.kind === "ref" ? { ref: query.ref } : {}),
    };
  }
}

/** One node's state, filtered to what the request asked for. A field the request
 *  did not name is ABSENT — the port's rule, and what lets `find`'s probe pay for
 *  one round trip while the verify family pays for another. */
function readingFor(node: NativeNode, want: ElementProbeRequest): ElementReading {
  return {
    kind: "reading",
    ...(want.matches ? { matches: 1 } : {}),
    ...(want.visible ? { visible: node.visible } : {}),
    ...(want.notVisibleReason && !node.visible
      ? { notVisibleReason: "XCUITest reports the element as not hittable on the current screen" }
      : {}),
    ...(want.enabled ? { enabled: node.enabled } : {}),
    ...(want.text ? { text: node.label ?? null } : {}),
    ...(want.value ? { value: node.value ?? node.placeholder ?? null } : {}),
    ...(want.attribute !== undefined ? { attribute: attributeOf(node, want.attribute) } : {}),
  };
}

/** Attribute name → the node field it reads. The names are the PLATFORM's own,
 *  so `verify_attribute({name: "accessibilityIdentifier"})` reads what an iOS
 *  engineer expects it to; the aliases beside each are what a React Native author
 *  and a WebDriver user call the same thing. */
const ATTRIBUTE_READERS: Readonly<Record<string, (n: NativeNode) => string | null>> = {
  accessibilityidentifier: (n) => n.identifier ?? null,
  identifier: (n) => n.identifier ?? null,
  testid: (n) => n.identifier ?? null,
  label: (n) => n.label ?? null,
  name: (n) => n.label ?? null,
  value: (n) => n.value ?? null,
  placeholder: (n) => n.placeholder ?? null,
  placeholdervalue: (n) => n.placeholder ?? null,
  type: (n) => n.type,
  enabled: (n) => String(n.enabled),
  visible: (n) => String(n.visible),
};

/** The named attribute of a node, or null when it carries none. */
function attributeOf(node: NativeNode, name: string): string | null {
  return ATTRIBUTE_READERS[name.toLowerCase()]?.(node) ?? null;
}
