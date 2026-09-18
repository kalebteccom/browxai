// The selector model, pinned. RFC 0008 §3 exists because a competing tool was
// rejected for misreporting taps: its refs were positional, so a layout change
// silently pointed a ref at whatever now occupied the old rectangle, and a tap
// reported against the wrong element poisons the evidence the whole workflow
// produces.
//
// The rule that prevents it is one line in `nativeElementKey` — when an
// accessibility identifier is present, `path` is passed empty — and these tests
// are what hold it. The load-bearing case is "move a node and assert the ref
// holds"; its mirror, "move a node with no identifier and assert the ref does
// NOT hold", matters just as much, because a scheme where every ref survives
// everything is a scheme that cannot report staleness.

import { describe, it, expect } from "vitest";
import type { NativeNode } from "../engine/native-types.js";
import { RefRegistry } from "./refs.js";
import {
  IOS_IDENTIFIER_ATTR,
  countAddressable,
  nativeElementKey,
  roleForType,
  toA11yTree,
  walkNative,
} from "./ios-hierarchy.js";

function node(partial: Partial<NativeNode> & { type: string }): NativeNode {
  return {
    enabled: true,
    visible: true,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    children: [],
    ...partial,
  };
}

/** A checkout screen: a nav bar, a card field, a submit button carrying a testID,
 *  and a cancel button carrying none. `extraRows` inserts BUTTONS above them,
 *  which is what a layout change that actually moves things looks like — a
 *  dismissible promo banner, a retry control, a new action row. Buttons, because
 *  a structural path segment is indexed per element TYPE: inserting a `StaticText`
 *  would leave every button's path untouched and the test would prove nothing. */
function checkoutScreen(extraRows: number): NativeNode {
  const rows: NativeNode[] = [];
  for (let i = 0; i < extraRows; i++) {
    rows.push(node({ type: "Button", label: `Notice ${i}` }));
  }
  return node({
    type: "Application",
    label: "Checkout",
    children: [
      node({ type: "NavigationBar", label: "Checkout" }),
      ...rows,
      node({ type: "TextField", label: "Card number", value: "4242" }),
      node({ type: "Button", identifier: "checkout-submit", label: "Pay now" }),
      node({ type: "Button", label: "Cancel" }),
    ],
  });
}

function refOf(tree: ReturnType<typeof toA11yTree>, predicate: (n: { name?: string }) => boolean) {
  const stack = [tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (predicate(n)) return n.ref;
    stack.push(...n.children);
  }
  return undefined;
}

describe("the ref survives a layout change when an identifier is present", () => {
  it("keeps the same ref after three rows are inserted above the node", () => {
    // The whole point. One registry, two snapshots of the same screen with the
    // node at a different structural position in each.
    const refs = new RefRegistry();
    const before = toA11yTree(checkoutScreen(0), refs, "app://com.acme.checkout/");
    const after = toA11yTree(checkoutScreen(3), refs, "app://com.acme.checkout/");
    const submitBefore = refOf(before, (n) => n.name === "Pay now");
    const submitAfter = refOf(after, (n) => n.name === "Pay now");
    expect(submitBefore).toBeDefined();
    expect(
      submitAfter,
      "an identified node that moved minted a NEW ref — the path is leaking into the key",
    ).toBe(submitBefore);
  });

  it("mints a NEW ref for a node with no identifier that moved", () => {
    // The honest other half. Without an identifier the ref IS snapshot-local, and
    // a scheme that pretended otherwise would report a stale ref as live.
    const refs = new RefRegistry();
    const before = toA11yTree(checkoutScreen(0), refs, "app://com.acme.checkout/");
    const after = toA11yTree(checkoutScreen(3), refs, "app://com.acme.checkout/");
    expect(refOf(after, (n) => n.name === "Cancel")).not.toBe(
      refOf(before, (n) => n.name === "Cancel"),
    );
  });

  it("keys an identified node on type, label and identifier — never on where it sits", () => {
    const identified = { type: "Button", label: "Pay now", identifier: "checkout-submit" };
    expect(nativeElementKey(identified, "Application/Button")).toBe(
      nativeElementKey(identified, "Application/Other/Stack/Button[7]"),
    );
    const anonymous = { type: "Button", label: "Cancel" };
    expect(nativeElementKey(anonymous, "Application/Button")).not.toBe(
      nativeElementKey(anonymous, "Application/Button[2]"),
    );
  });

  it("gives two elements with the same identifier and different labels different refs", () => {
    // The identifier is the strongest signal, not the only one — an app that
    // reuses one testID across a list still gets distinguishable refs while the
    // labels differ.
    expect(nativeElementKey({ type: "Cell", label: "Row 1", identifier: "row" }, "a")).not.toBe(
      nativeElementKey({ type: "Cell", label: "Row 2", identifier: "row" }, "a"),
    );
  });
});

describe("structural paths", () => {
  it("indexes a segment by element TYPE, so a sibling of another type does not renumber it", () => {
    const withoutBanner = node({
      type: "Application",
      children: [node({ type: "Button", label: "A" }), node({ type: "Button", label: "B" })],
    });
    const withBanner = node({
      type: "Application",
      children: [
        node({ type: "Image", label: "Banner" }),
        node({ type: "Button", label: "A" }),
        node({ type: "Button", label: "B" }),
      ],
    });
    const pathOf = (root: NativeNode, label: string): string =>
      [...walkNative(root)].find((e) => e.node.label === label)!.path;
    expect(pathOf(withoutBanner, "B")).toBe("Application/Button[2]");
    expect(pathOf(withBanner, "B")).toBe("Application/Button[2]");
  });

  it("does not index a type that appears once", () => {
    const tree = node({ type: "Application", children: [node({ type: "Button", label: "A" })] });
    expect([...walkNative(tree)].map((e) => e.path)).toEqual(["Application", "Application/Button"]);
  });

  it("yields every node exactly once, parent before child", () => {
    const entries = [...walkNative(checkoutScreen(2))];
    expect(entries).toHaveLength(7);
    expect(new Set(entries.map((e) => e.path)).size).toBe(7);
    expect(entries[0]!.path).toBe("Application");
  });
});

describe("the type → role mapping", () => {
  it("maps the exact cases exactly", () => {
    expect(roleForType("Button")).toBe("button");
    expect(roleForType("TextField")).toBe("textbox");
    expect(roleForType("SecureTextField")).toBe("textbox");
    expect(roleForType("Switch")).toBe("switch");
    expect(roleForType("Link")).toBe("link");
  });

  it("maps iOS StaticText to `text`, NOT to browxai's presentational StaticText", () => {
    // Same word, opposite meaning. On the web the serialiser drops a StaticText
    // because Blink emits one per text run; on iOS it is often the only node
    // carrying the screen's content, and dropping it would empty the snapshot.
    expect(roleForType("StaticText")).toBe("text");
  });

  it("falls through to `generic` for a type it does not name, and keeps the raw type", () => {
    expect(roleForType("SomeFutureElementType")).toBe("generic");
    const refs = new RefRegistry();
    const tree = toA11yTree(
      node({ type: "Application", children: [node({ type: "SomeFutureElementType" })] }),
      refs,
      "app://x/",
    );
    expect(tree.children[0]!.role).toBe("generic");
    expect(tree.children[0]!.tag, "the raw XCUITest type must survive the mapping").toBe(
      "SomeFutureElementType",
    );
  });
});

describe("the composed A11yNode tree", () => {
  const refs = new RefRegistry();
  const tree = toA11yTree(checkoutScreen(0), refs, "app://com.acme.checkout/Checkout");

  it("names the root for the screen, not for a URL it does not have", () => {
    expect(tree.role).toBe("WebArea");
    expect(tree.name).toBe("app://com.acme.checkout/Checkout");
  });

  it("carries the identifier as a test attribute that names where it came from", () => {
    const submit = tree.children.find((c) => c.name === "Pay now")!;
    expect(submit.testId).toBe("checkout-submit");
    expect(submit.testIdAttr).toBe(IOS_IDENTIFIER_ATTR);
    // Which is what makes `buildSelectorHint` emit a tier-1 hint naming the
    // attribute it queried rather than a pixel pair.
    expect(IOS_IDENTIFIER_ATTR).toBe("accessibilityIdentifier");
  });

  it("reads label into name and value into value", () => {
    const field = tree.children.find((c) => c.role === "textbox")!;
    expect(field.name).toBe("Card number");
    expect(field.value).toBe("4242");
  });

  it("uses the placeholder as the value ONLY when there is no value", () => {
    const refs2 = new RefRegistry();
    const withPlaceholder = toA11yTree(
      node({
        type: "Application",
        children: [node({ type: "TextField", label: "Email", placeholder: "you@example.com" })],
      }),
      refs2,
      "app://x/",
    );
    expect(withPlaceholder.children[0]!.value).toBe("you@example.com");
  });

  it("reports disabled as a flag rather than dropping the node", () => {
    const refs2 = new RefRegistry();
    const tree2 = toA11yTree(
      node({
        type: "Application",
        children: [node({ type: "Button", label: "Pay", enabled: false })],
      }),
      refs2,
      "app://x/",
    );
    expect(tree2.children[0]!.disabled).toBe(true);
  });

  it("preserves the hierarchy's shape", () => {
    const refs2 = new RefRegistry();
    const nested = toA11yTree(
      node({
        type: "Application",
        children: [
          node({
            type: "Table",
            children: [
              node({ type: "Cell", children: [node({ type: "StaticText", label: "x" })] }),
            ],
          }),
        ],
      }),
      refs2,
      "app://x/",
    );
    expect(nested.children[0]!.role).toBe("list");
    expect(nested.children[0]!.children[0]!.role).toBe("listitem");
    expect(nested.children[0]!.children[0]!.children[0]!.role).toBe("text");
  });
});

describe("countAddressable", () => {
  it("separates identified from merely labelled, which is the app team's fix list", () => {
    // browxai cannot make an element addressable that the app never labelled.
    // Counting the two tiers apart is what turns "the selector model degraded"
    // into a number someone can act on.
    expect(countAddressable(checkoutScreen(2))).toEqual({
      identified: 1,
      labelled: 6,
      total: 7,
    });
  });
});
