// The ios-app target parser. The contract that matters: a hint `find` hands the
// agent must resolve through `click` unchanged, so the shapes `buildSelectorHint`
// emits are the shapes parsed here.

import { describe, it, expect } from "vitest";
import type { NativeNode } from "../engine/native-types.js";
import { parseNativeSelector, UnparseableSelectorError } from "./ios-selector.js";

function node(partial: Partial<NativeNode> & { type: string }): NativeNode {
  return {
    enabled: true,
    visible: true,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
    ...partial,
  };
}

const SUBMIT = node({ type: "Button", identifier: "checkout-submit", label: "Pay now" });
const FIELD = node({ type: "TextField", label: "Card number", value: "4242" });

describe("parseNativeSelector", () => {
  it("resolves the tier-1 hint `buildSelectorHint` emits for an identified element", () => {
    // The round trip: `A11yNode.testIdAttr` is `accessibilityIdentifier`, so the
    // hint reads `[accessibilityIdentifier="checkout-submit"]` and comes back here.
    const m = parseNativeSelector('[accessibilityIdentifier="checkout-submit"]');
    expect(m.matches(SUBMIT)).toBe(true);
    expect(m.matches(FIELD)).toBe(false);
  });

  it("accepts the ecosystem's two other spellings of the same thing", () => {
    for (const spelling of [
      '[testID="checkout-submit"]',
      '[identifier="checkout-submit"]',
      "~checkout-submit",
    ]) {
      expect(parseNativeSelector(spelling).matches(SUBMIT), spelling).toBe(true);
    }
  });

  it("resolves the tier-2 role-and-name hint", () => {
    expect(parseNativeSelector('role=button[name="Pay now"]').matches(SUBMIT)).toBe(true);
    expect(parseNativeSelector('role=textbox[name="Pay now"]').matches(SUBMIT)).toBe(false);
  });

  it("matches a name EXACTLY — a substring match would act on the wrong element", () => {
    // `getByRole`'s substring semantics would make `[name="Pay"]` match "Pay now"
    // and "Payment method" alike.
    expect(parseNativeSelector('role=button[name="Pay"]').matches(SUBMIT)).toBe(false);
  });

  it("reads `name` as the accessible name, never as a second spelling of the identifier", () => {
    expect(parseNativeSelector('[name="Pay now"]').matches(SUBMIT)).toBe(true);
    expect(parseNativeSelector('[name="checkout-submit"]').matches(SUBMIT)).toBe(false);
  });

  it("resolves the tier-5 role-only hint", () => {
    expect(parseNativeSelector("role=button").matches(SUBMIT)).toBe(true);
    expect(parseNativeSelector("role=button").matches(FIELD)).toBe(false);
  });

  it("reads value and the raw XCUITest type", () => {
    expect(parseNativeSelector('[value="4242"]').matches(FIELD)).toBe(true);
    expect(parseNativeSelector("[type=TextField]").matches(FIELD)).toBe(true);
    expect(parseNativeSelector("[type=TextField]").matches(SUBMIT)).toBe(false);
  });

  it("takes a bare string as the identifier first, the label second", () => {
    expect(parseNativeSelector("checkout-submit").matches(SUBMIT)).toBe(true);
    expect(parseNativeSelector("Card number").matches(FIELD)).toBe(true);
    // An identified element is NOT matched by its label as a bare string: the
    // identifier is the addressable handle and a bare label would be a second,
    // looser one.
    expect(parseNativeSelector("Pay now").matches(SUBMIT)).toBe(false);
  });

  it("refuses an attribute it cannot query, naming the forms it can", () => {
    expect(() => parseNativeSelector("[colour=red]")).toThrow(UnparseableSelectorError);
    expect(() => parseNativeSelector("   ")).toThrow(/unaddressable-target/);
    expect(() => parseNativeSelector("[colour=red]")).toThrow(/accessibilityIdentifier/);
  });

  it("describes itself in the identifier's canonical form whatever spelling arrived", () => {
    expect(parseNativeSelector("~x").describe).toBe('[accessibilityIdentifier="x"]');
  });
});
