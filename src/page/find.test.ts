import { describe, it, expect } from "vitest";
import { buildSelectorHint, scoreNode, noVisibleCandidateWarning } from "./find.js";
import type { A11yNode } from "./a11y.js";

function n(role: string, name: string | undefined, testId?: string, extra: Partial<A11yNode> = {}): A11yNode {
  return { ref: "e1", role, name, testId, children: [], ...extra };
}

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

  it("tier 4: stable HTML id when no testId/name (Phase-2)", () => {
    const h = buildSelectorHint({ role: "div", id: "main-content" });
    expect(h.tier).toBe(4);
    expect(h.stability).toBe("low");
    expect(h.hint).toBe("#main-content");
  });

  it("tier 4 rejects content-keyed ids and falls through to tier 5", () => {
    const numeric = buildSelectorHint({ role: "div", id: "12345" });
    expect(numeric.tier).toBe(5);
    const mui = buildSelectorHint({ role: "div", id: "mui-1234" });
    expect(mui.tier).toBe(5);
    const uuid = buildSelectorHint({ role: "div", id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(uuid.tier).toBe(5);
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

describe("scoreNode (round-3 ask #14: weight testId hits more, especially for inputs)", () => {
  it("exact testId match dominates", () => {
    const q = "app-common-time-input-seconds";
    const node = n("textbox", undefined, "app-common-time-input-seconds");
    const score = scoreNode(node, q, q.split(/\s+/));
    expect(score).toBeGreaterThan(20);
  });

  it("input-shaped roles get a testId-token boost beyond what buttons get", () => {
    const q = "the time-input-seconds inside the start-time-input panel";
    const tokens = q.toLowerCase().split(/\s+/);
    const input = n("textbox", undefined, "app-common-time-input-seconds");
    const button = n("button", undefined, "app-common-time-input-seconds");
    const inputScore = scoreNode(input, q.toLowerCase(), tokens);
    const buttonScore = scoreNode(button, q.toLowerCase(), tokens);
    expect(inputScore).toBeGreaterThan(buttonScore);
  });

  it("ignores single-character noise tokens in the per-token boost", () => {
    // 1-char tokens like "a", "x" shouldn't artificially boost score —
    // every testId would otherwise pick up a free +2 per token.
    const q = "a x y";
    const node = n("button", undefined, "panel-x-y");
    const score = scoreNode(node, q, q.split(/\s+/));
    // No exact-query or substring-query hits; per-token loop skips length-<2.
    // role isn't in the query. So score = 0.
    expect(score).toBe(0);
  });
});

describe("scoreNode — W-G4 icon-only controls", () => {
  it("amplifies per-testId-token weight when the node has no accessible name", () => {
    // Two candidates with overlapping testIds. The "target feature tab" is
    // the intended hit; the "feature other tab" is a neighbouring icon-only
    // sibling. Both are name-less buttons; both score from testId tokens only.
    const q = "feature tab in side panel";
    const tokens = q.split(/\s+/);
    const target = n("button", undefined, "side-panel-feature-tab");
    const neighbour = n("button", undefined, "side-panel-other-tab");
    const targetScore = scoreNode(target, q, tokens);
    const neighbourScore = scoreNode(neighbour, q, tokens);
    expect(targetScore).toBeGreaterThan(neighbourScore);
  });

  it("non-icon-only controls still rank correctly (name boost wins)", () => {
    // When a candidate has a name that matches the query, name boosts should
    // out-rank a testId-only icon sibling.
    const q = "feature tab";
    const tokens = q.split(/\s+/);
    const named = n("button", "Feature tab", "side-panel-feature-tab");
    const iconOnly = n("button", undefined, "side-panel-feature-tab");
    expect(scoreNode(named, q, tokens)).toBeGreaterThan(scoreNode(iconOnly, q, tokens));
  });
});

describe("noVisibleCandidateWarning — W-J2 capability-aware", () => {
  it("names no fallback tool when none are enabled", () => {
    const w = noVisibleCandidateWarning(3, { coords: false, evalJs: false });
    expect(w).toContain("no visible candidate");
    expect(w).not.toContain("coords");
    expect(w).not.toContain("eval_js");
  });

  it("names only coords when only action is enabled", () => {
    const w = noVisibleCandidateWarning(2, { coords: true, evalJs: false });
    expect(w).toContain("coords");
    expect(w).not.toContain("eval_js");
  });

  it("names only eval_js when only eval is enabled", () => {
    const w = noVisibleCandidateWarning(1, { coords: false, evalJs: true });
    expect(w).toContain("eval_js");
    expect(w).not.toContain("coords");
  });

  it("names both when both are enabled, and reports the count", () => {
    const w = noVisibleCandidateWarning(5, { coords: true, evalJs: true });
    expect(w).toContain("all 5 match(es)");
    expect(w).toContain("coords");
    expect(w).toContain("eval_js");
  });

  it("defaults to no suggestions when hints are omitted", () => {
    const w = noVisibleCandidateWarning(1);
    expect(w).not.toContain("You may want to");
  });
});
