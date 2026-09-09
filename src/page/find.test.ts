import { describe, it, expect } from "vitest";
import {
  buildSelectorHint,
  scoreNode,
  noVisibleCandidateWarning,
  rankByVisibility,
  type FindCandidate,
} from "./find.js";
import type { A11yNode } from "./a11y.js";

function cand(
  ref: string,
  score: number,
  actionable: FindCandidate["actionable"],
  role = "button",
): FindCandidate {
  return {
    ref,
    role,
    stability: "high",
    selectorHint: `#${ref}`,
    selectorTier: 1,
    bbox: null,
    clipped: actionable !== true,
    actionable,
    score,
  };
}

function n(
  role: string,
  name: string | undefined,
  testId?: string,
  extra: Partial<A11yNode> = {},
): A11yNode {
  return { ref: "e1", role, name, testId, children: [], ...extra };
}

describe("buildSelectorHint preference order", () => {
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

  it("tier 4: stable HTML id when no testId/name", () => {
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

  it("tier 1 honours testIdAttr — emits the matched attribute, not hardcoded data-testid", () => {
    const h = buildSelectorHint({
      role: "generic",
      testId: "feature-panel-language-input",
      testIdAttr: "data-type",
    });
    expect(h.tier).toBe(1);
    expect(h.stability).toBe("high");
    expect(h.hint).toBe('[data-type="feature-panel-language-input"]');
  });

  it("tier 1 fires on a non-roled element (DOM-walk only) — no role gating", () => {
    // A plain <div data-testid="foo"> has role "generic"/"div"; tier-1 still fires.
    const h = buildSelectorHint({ role: "div", testId: "mini-library", testIdAttr: "data-testid" });
    expect(h.tier).toBe(1);
    expect(h.stability).toBe("high");
    expect(h.hint).toBe('[data-testid="mini-library"]');
  });
});

describe("scoreNode — testId weighting for inputs", () => {
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

describe("scoreNode — natural-language queries name the element inside a phrase", () => {
  // A Hacker News front page: the nav holds a link whose accessible name is
  // exactly the word the query used, and the story list holds headlines full of
  // the query's function words. Comparing the name against the *whole* query
  // never fires for a phrase like this, so the nav link used to rank last.
  const q = "the past link in the top navigation bar";
  const tokens = q.split(/\s+/);
  // DOM-walk-sourced nodes report the bare tag in `role`, which is what a
  // table-markup page like this actually produces.
  const navLink = n("a", "past");
  const headline = n("a", "Show HN: I built a tool for the top of the stack");
  const prose = n("a", "The past is a foreign country for the top navigation of the web");

  it("the exact-name nav link outranks every headline that merely shares function words", () => {
    const navScore = scoreNode(navLink, q, tokens);
    expect(navScore).toBeGreaterThan(scoreNode(headline, q, tokens));
    expect(navScore).toBeGreaterThan(scoreNode(prose, q, tokens));
  });

  it("holds when the a11y tree supplies the same nodes with real ARIA roles", () => {
    const asLink = (name: string) => n("link", name);
    expect(scoreNode(asLink("past"), q, tokens)).toBeGreaterThan(
      scoreNode(asLink("Show HN: I built a tool for the top of the stack"), q, tokens),
    );
  });

  it("a name matching only the query's stopwords scores nothing", () => {
    expect(
      scoreNode(n("a", "the of the"), "the settings gear in the top bar", [
        "the",
        "settings",
        "gear",
        "in",
        "the",
        "top",
        "bar",
      ]),
    ).toBe(0);
    expect(scoreNode(n("a", "The"), q, tokens)).toBe(0);
  });

  it("a multi-token name match beats a single-token one inside the same query", () => {
    const query = "click the sign in to your account button at the top";
    const qt = query.split(/\s+/);
    const multi = n("button", "Sign in to your account");
    const single = n("button", "account");
    expect(scoreNode(multi, query, qt)).toBeGreaterThan(scoreNode(single, query, qt));
  });

  it("matches a quoted target token against the bare accessible name", () => {
    const query = 'the "past" link';
    const qt = query.split(/\s+/);
    expect(scoreNode(n("link", "past"), query, qt)).toBeGreaterThan(
      scoreNode(n("link", "past tense grammar reference for the link layer"), query, qt),
    );
  });
});

describe("scoreNode — icon-only controls", () => {
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

  it("tooltip/sr-only text lifts an icon-only control over a bare-testId sibling", () => {
    // Both are name-less; only the target carries a tooltip-derived `text`
    // that names the intent. The text signal should break the tie.
    const q = "ai feature panel";
    const tokens = q.split(/\s+/);
    const withTooltip = n("button", undefined, "sp-tab-3", { text: "AI feature panel" });
    const bare = n("button", undefined, "sp-tab-4");
    expect(scoreNode(withTooltip, q, tokens)).toBeGreaterThan(scoreNode(bare, q, tokens));
  });

  it("active/selected state disambiguates the live panel tab from inert siblings", () => {
    // Identical icon-only testId-token signal; the *selected* one is the
    // feature area the agent means.
    const q = "side panel feature tab";
    const tokens = q.split(/\s+/);
    const active = n("tab", undefined, "side-panel-feature-tab", { selected: true });
    const inert = n("tab", undefined, "side-panel-feature-tab");
    expect(scoreNode(active, q, tokens)).toBeGreaterThan(scoreNode(inert, q, tokens));
  });

  it("active-state bonus never fabricates a match from nothing (gated on s>0)", () => {
    const q = "totally unrelated query";
    const tokens = q.split(/\s+/);
    const selectedButNoMatch = n("tab", undefined, "xyz", { selected: true });
    expect(scoreNode(selectedButNoMatch, q, tokens)).toBe(0);
  });
});

describe("noVisibleCandidateWarning — capability-aware", () => {
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

  it("names the capability-free recovery even when no hints are passed", () => {
    const w = noVisibleCandidateWarning(1);
    expect(w).toContain("`snapshot`");
    expect(w).toContain("re-run `find`");
    expect(w).not.toContain("coords");
    expect(w).not.toContain("eval_js");
  });

  it("frames coordinates as the canvas last resort, behind re-query and snapshot", () => {
    const w = noVisibleCandidateWarning(2, { coords: true, evalJs: false });
    expect(w).toContain("point_probe");
    expect(w).toContain("Last resort");
    expect(w.indexOf("`snapshot`")).toBeLessThan(w.indexOf("coords"));
  });
});

describe("rankByVisibility — visibleOnly partition", () => {
  const mixed = [
    cand("hiHidden", 99, "off-screen"),
    cand("loVisible", 10, true),
    cand("midDisabled", 50, "disabled"),
    cand("hiVisible", 90, true),
  ];

  it("default: visible first (score order), hidden appended (not dropped)", () => {
    const { ranked, visibleCount } = rankByVisibility(mixed, false);
    expect(ranked.map((c) => c.ref)).toEqual(["loVisible", "hiVisible", "hiHidden", "midDisabled"]);
    expect(visibleCount).toBe(2);
  });

  it("visibleOnly: hidden tier dropped entirely", () => {
    const { ranked, visibleCount } = rankByVisibility(mixed, true);
    expect(ranked.map((c) => c.ref)).toEqual(["loVisible", "hiVisible"]);
    expect(visibleCount).toBe(2);
  });

  it("visibleOnly with zero visible → empty list but visibleCount 0 (caller still warns)", () => {
    const allHidden = [cand("a", 80, "off-screen"), cand("b", 70, "covered")];
    const { ranked, visibleCount } = rankByVisibility(allHidden, true);
    expect(ranked).toEqual([]);
    expect(visibleCount).toBe(0);
  });
});

describe("rankByVisibility — container demotion", () => {
  it("demotes a high-scored structural container below an actionable interactive match", () => {
    // The reported failure: an enclosing toolbox container scores highest on
    // an aliased query, the actual tab is rank 4. Containers must sit behind
    // the interactive control they enclose.
    const cands = [
      cand("toolboxRegion", 90, true, "region"),
      cand("railGroup", 80, true, "group"),
      cand("featureTab", 30, true, "tab"),
    ];
    const { ranked } = rankByVisibility(cands, false);
    expect(ranked.map((c) => c.ref)).toEqual(["featureTab", "toolboxRegion", "railGroup"]);
  });

  it("demotes a bare-tag `nav` below a bare-tag `<a>`, not just ARIA-role containers", () => {
    // DOM-walk candidates carry the HTML tag in `role`, so `nav` / `a` never hit
    // the ARIA-named CONTAINER_ROLES / INTERACTIVE_ROLES sets directly. Both
    // sides of the partition have to resolve through `effectiveAriaRole` or an
    // enclosing nav outranks the link inside it on a semantically thin page.
    const cands = [cand("navBar", 90, true, "nav"), cand("pastLink", 30, true, "a")];
    const { ranked } = rankByVisibility(cands, false);
    expect(ranked.map((c) => c.ref)).toEqual(["pastLink", "navBar"]);
  });

  it("leaves containers in place when NO actionable interactive candidate matched", () => {
    // "down-rank the container unless no actionable child matches" — if the
    // container is the best we have, don't bury it.
    const cands = [cand("regionA", 50, true, "region"), cand("groupB", 40, true, "group")];
    const { ranked } = rankByVisibility(cands, false);
    expect(ranked.map((c) => c.ref)).toEqual(["regionA", "groupB"]);
  });

  it("is stable within each sub-group (leaf order and container order preserved)", () => {
    const cands = [
      cand("region1", 95, true, "region"),
      cand("btnA", 60, true, "button"),
      cand("nav2", 70, true, "navigation"),
      cand("tabB", 55, true, "tab"),
    ];
    const { ranked } = rankByVisibility(cands, false);
    // leaves keep their relative order (btnA before tabB), then containers
    // keep theirs (region1 before nav2).
    expect(ranked.map((c) => c.ref)).toEqual(["btnA", "tabB", "region1", "nav2"]);
  });

  it("demotion stays within the visible tier — hidden still last", () => {
    const cands = [
      cand("visRegion", 90, true, "region"),
      cand("visBtn", 20, true, "button"),
      cand("hidTab", 99, "off-screen", "tab"),
    ];
    const { ranked } = rankByVisibility(cands, false);
    expect(ranked.map((c) => c.ref)).toEqual(["visBtn", "visRegion", "hidTab"]);
  });
});

describe("scoreNode — DOM-walk candidates carry bare HTML tags, not ARIA roles", () => {
  // When the CDP a11y tree is thin the candidates come from the DOM-walk
  // fallback, which puts `getAttribute("role") || tagName` in `role`. The
  // interactive bonus and the container demotion resolve that to the implicit
  // ARIA role at the point of use — `role` itself is hashed into `elementKey`,
  // so normalising it would rotate every DOM-sourced ref.
  const domLink = (name: string) =>
    n("a", name, undefined, { tag: "a", hasHref: true, source: "dom" });

  it("a DOM-walk <a href> gets the interactive bonus a CDP link gets", () => {
    const q = "past";
    const tokens = ["past"];
    const cdpLink = n("link", "past");
    expect(scoreNode(domLink("past"), q, tokens)).toBe(scoreNode(cdpLink, q, tokens));
  });

  it("an <a> with no href is not interactive", () => {
    const q = "past";
    const tokens = ["past"];
    const anchor = n("a", "past", undefined, { tag: "a", hasHref: false, source: "dom" });
    expect(scoreNode(anchor, q, tokens)).toBe(scoreNode(domLink("past"), q, tokens) - 2);
  });

  it("<input> resolves by type — a checkbox is interactive, a hidden input is not", () => {
    const q = "agree";
    const tokens = ["agree"];
    const checkbox = n("input", "agree", undefined, { tag: "input", inputType: "checkbox" });
    const hidden = n("input", "agree", undefined, { tag: "input", inputType: "hidden" });
    expect(scoreNode(checkbox, q, tokens)).toBe(scoreNode(hidden, q, tokens) + 2);
  });

  it("an explicit role= attribute still wins over the tag", () => {
    const q = "save";
    const tokens = ["save"];
    const roled = n("button", "save", undefined, { tag: "div", source: "dom" });
    const bare = n("div", "save", undefined, { tag: "div", source: "dom" });
    expect(scoreNode(roled, q, tokens)).toBe(scoreNode(bare, q, tokens) + 2);
  });

  it("leaves CDP-sourced ARIA roles untouched — the mapping is identity for them", () => {
    const q = "feature tab in side panel";
    const tokens = q.split(/\s+/);
    // Same name, only the role differs: an interactive ARIA role earns the +2 a
    // non-interactive one does not, and nothing else about the score moves.
    // Asserted as a delta rather than two absolutes so the case survives changes
    // to the rest of the scoring formula.
    const interactive = scoreNode(n("tab", "side panel"), q, tokens);
    const nonInteractive = scoreNode(n("region", "side panel"), q, tokens);
    expect(interactive).toBe(nonInteractive + 2);
  });

  it("ranks the past link above the top navigation bar that encloses it", () => {
    const q = "the past link in the top navigation bar";
    const tokens = q.split(/\s+/);
    const link = domLink("past");
    const nav = n("nav", "Hacker News new past comments ask show jobs submit", undefined, {
      tag: "nav",
      source: "dom",
    });
    expect(scoreNode(link, q, tokens)).toBeGreaterThan(scoreNode(nav, q, tokens));
  });
});

describe("rankByVisibility — demotion resolves bare tags too", () => {
  it("demotes a DOM-walk <nav> below the DOM-walk <a> it encloses", () => {
    const cands = [cand("topNav", 90, true, "nav"), cand("pastLink", 30, true, "a")];
    const { ranked } = rankByVisibility(cands, false);
    expect(ranked.map((c) => c.ref)).toEqual(["pastLink", "topNav"]);
  });

  it("demotes a DOM-walk <div> wrapper below an interactive control", () => {
    const cands = [cand("wrapper", 80, true, "div"), cand("saveBtn", 20, true, "button")];
    const { ranked } = rankByVisibility(cands, false);
    expect(ranked.map((c) => c.ref)).toEqual(["saveBtn", "wrapper"]);
  });

  it("leaves DOM-walk containers in place when nothing interactive matched", () => {
    const cands = [cand("topNav", 90, true, "nav"), cand("wrapper", 80, true, "div")];
    const { ranked } = rankByVisibility(cands, false);
    expect(ranked.map((c) => c.ref)).toEqual(["topNav", "wrapper"]);
  });
});
