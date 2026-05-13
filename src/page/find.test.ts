import { describe, it, expect } from "vitest";
import { buildSelectorHint } from "./find.js";

describe("buildSelectorHint preference order (ask #4)", () => {
  it("tier 1: data-testid beats everything, stability=high", () => {
    const h = buildSelectorHint({ role: "button", name: "Save", testId: "save-btn" });
    expect(h.tier).toBe(1);
    expect(h.stability).toBe("high");
    expect(h.hint).toBe('[data-testid="save-btn"]');
  });

  it("tier 2: role+name when no testid, stability=medium", () => {
    const h = buildSelectorHint({ role: "button", name: "Save" });
    expect(h.tier).toBe(2);
    expect(h.stability).toBe("medium");
    expect(h.hint).toBe('role=button[name="Save"]');
  });

  it('tier-2 quotes "names" with embedded quotes correctly', () => {
    const h = buildSelectorHint({ role: "link", name: 'Hello "world"' });
    expect(h.hint).toBe('role=link[name="Hello \\"world\\""]');
  });

  it("tier 5: role-only fallback when nothing distinguishing, stability=low", () => {
    const h = buildSelectorHint({ role: "generic" });
    expect(h.tier).toBe(5);
    expect(h.stability).toBe("low");
    expect(h.hint).toBe("role=generic");
  });

  it("tier 1 honours testIdAttr — emits the matched attribute, not hardcoded data-testid (ask #10)", () => {
    const h = buildSelectorHint({ role: "generic", testId: "feature-panel-language-input", testIdAttr: "data-type" });
    expect(h.tier).toBe(1);
    expect(h.stability).toBe("high");
    expect(h.hint).toBe('[data-type="feature-panel-language-input"]');
  });

  it("tier 1 fires on a non-roled element (DOM-walk only) — no role gating (ask #10)", () => {
    // A plain <div data-testid="foo"> has role "generic"/"div"; tier-1 still fires.
    const h = buildSelectorHint({ role: "div", testId: "mini-library", testIdAttr: "data-testid" });
    expect(h.tier).toBe(1);
    expect(h.stability).toBe("high");
    expect(h.hint).toBe('[data-testid="mini-library"]');
  });
});
