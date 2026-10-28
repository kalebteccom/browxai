import { describe, it, expect } from "vitest";
import {
  buildSelectorHint,
  scoreNode,
  noVisibleCandidateWarning,
  rankByVisibility,
  isCandidateRole,
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
  it.each([
    {
      name: "tier 1: data-testid beats everything",
      input: { role: "button", name: "Save", testId: "save-btn" },
      tier: 1,
      stability: "high",
      hint: '[data-testid="save-btn"]',
    },
    {
      name: "tier 2: role+name when no testid",
      input: { role: "button", name: "Save" },
      tier: 2,
      stability: "medium",
      hint: 'role=button[name="Save"]',
    },
    {
      name: "tier 4: stable HTML id when no testId/name",
      input: { role: "div", id: "main-content" },
      tier: 4,
      stability: "low",
      hint: "#main-content",
    },
    { name: "tier 4 rejects a numeric id", input: { role: "div", id: "12345" }, tier: 5 },
    { name: "tier 4 rejects a mui- id", input: { role: "div", id: "mui-1234" }, tier: 5 },
    {
      name: "tier 4 rejects a uuid id",
      input: { role: "div", id: "550e8400-e29b-41d4-a716-446655440000" },
      tier: 5,
    },
    {
      name: "tier 5: role-only fallback when nothing distinguishing",
      input: { role: "generic" },
      tier: 5,
      stability: "low",
      hint: "role=generic",
    },
    {
      name: "tier 1 honours testIdAttr, emitting the matched attribute",
      input: { role: "generic", testId: "feature-panel-language-input", testIdAttr: "data-type" },
      tier: 1,
      stability: "high",
      hint: '[data-type="feature-panel-language-input"]',
    },
  ] as Array<{
    name: string;
    input: Parameters<typeof buildSelectorHint>[0];
    tier: number;
    stability?: string;
    hint?: string;
  }>)("buildSelectorHint $name", ({ input, tier, stability, hint }) => {
    const h = buildSelectorHint(input);
    expect(h.tier).toBe(tier);
    if (stability !== undefined) expect(h.stability).toBe(stability);
    if (hint !== undefined) expect(h.hint).toBe(hint);
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

  it.each([
    {
      name: "the exact-name nav link outranks every headline that merely shares function words",
      query: q,
      better: navLink,
      worse: [headline, prose],
    },
    {
      name: "a multi-token name match beats a single-token one inside the same query",
      query: "click the sign in to your account button at the top",
      better: n("button", "Sign in to your account"),
      worse: [n("button", "account")],
    },
    {
      name: "a quoted target token matches the bare accessible name",
      query: 'the "past" link',
      better: n("link", "past"),
      worse: [n("link", "past tense grammar reference for the link layer")],
    },
  ])("$name", ({ query, better, worse }) => {
    const qt = query.split(/\s+/);
    for (const w of worse)
      expect(scoreNode(better, query, qt)).toBeGreaterThan(scoreNode(w, query, qt));
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
});

describe("scoreNode — icon-only controls", () => {
  it.each([
    {
      name: "amplifies per-testId-token weight when the node has no accessible name",
      query: "feature tab in side panel",
      better: n("button", undefined, "side-panel-feature-tab"),
      worse: n("button", undefined, "side-panel-other-tab"),
    },
    {
      name: "tooltip/sr-only text lifts an icon-only control over a bare-testId sibling",
      query: "ai feature panel",
      better: n("button", undefined, "sp-tab-3", { text: "AI feature panel" }),
      worse: n("button", undefined, "sp-tab-4"),
    },
    {
      name: "active/selected state disambiguates the live panel tab from inert siblings",
      query: "side panel feature tab",
      better: n("tab", undefined, "side-panel-feature-tab", { selected: true }),
      worse: n("tab", undefined, "side-panel-feature-tab"),
    },
  ])("icon-only: $name", ({ query, better, worse }) => {
    const tokens = query.split(/\s+/);
    expect(scoreNode(better, query, tokens)).toBeGreaterThan(scoreNode(worse, query, tokens));
  });

  it("active-state bonus never fabricates a match from nothing (gated on s>0)", () => {
    const q = "totally unrelated query";
    const tokens = q.split(/\s+/);
    const selectedButNoMatch = n("tab", undefined, "xyz", { selected: true });
    expect(scoreNode(selectedButNoMatch, q, tokens)).toBe(0);
  });
});

describe("noVisibleCandidateWarning — capability-aware", () => {
  it.each([
    {
      name: "names no fallback tool when none are enabled",
      count: 3,
      caps: { coords: false, evalJs: false },
      has: ["no visible candidate"],
      lacks: ["coords", "eval_js"],
    },
    {
      name: "names both when both are enabled, and reports the count",
      count: 5,
      caps: { coords: true, evalJs: true },
      has: ["all 5 match(es)", "coords", "eval_js"],
      lacks: [],
    },
  ])("$name", ({ count, caps, has, lacks }) => {
    const w = noVisibleCandidateWarning(count, caps);
    for (const h of has) expect(w).toContain(h);
    for (const l of lacks) expect(w).not.toContain(l);
  });
});

describe("rankByVisibility — visibleOnly partition", () => {
  const mixed = [
    cand("hiHidden", 99, "off-screen"),
    cand("loVisible", 10, true),
    cand("midDisabled", 50, "disabled"),
    cand("hiVisible", 90, true),
  ];

  it.each([
    {
      name: "default: visible first (score order), hidden appended (not dropped)",
      visibleOnly: false,
      refs: ["loVisible", "hiVisible", "hiHidden", "midDisabled"],
    },
    {
      name: "visibleOnly: hidden tier dropped entirely",
      visibleOnly: true,
      refs: ["loVisible", "hiVisible"],
    },
  ])("$name", ({ visibleOnly, refs }) => {
    const { ranked, visibleCount } = rankByVisibility(mixed, visibleOnly);
    expect(ranked.map((c) => c.ref)).toEqual(refs);
    expect(visibleCount).toBe(2);
  });
});

describe("rankByVisibility — container demotion", () => {
  it.each([
    {
      name: "demotes a high-scored structural container below an actionable interactive match",
      cands: [
        cand("toolboxRegion", 90, true, "region"),
        cand("railGroup", 80, true, "group"),
        cand("featureTab", 30, true, "tab"),
      ],
      refs: ["featureTab", "toolboxRegion", "railGroup"],
    },
    {
      name: "demotes a bare-tag `nav` below a bare-tag `<a>`, not just ARIA-role containers",
      cands: [cand("navBar", 90, true, "nav"), cand("pastLink", 30, true, "a")],
      refs: ["pastLink", "navBar"],
    },
    {
      name: "leaves containers in place when NO actionable interactive candidate matched",
      cands: [cand("regionA", 50, true, "region"), cand("groupB", 40, true, "group")],
      refs: ["regionA", "groupB"],
    },
  ])("$name", ({ cands, refs }) => {
    expect(rankByVisibility(cands, false).ranked.map((c) => c.ref)).toEqual(refs);
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

  it.each([
    {
      name: "a DOM-walk <a href> gets the interactive bonus a CDP link gets",
      q: "past",
      a: domLink("past"),
      b: n("link", "past"),
      delta: 0,
    },
    {
      name: "an <a> with no href is not interactive",
      q: "past",
      a: n("a", "past", undefined, { tag: "a", hasHref: false, source: "dom" }),
      b: domLink("past"),
      delta: -2,
    },
    {
      name: "<input> resolves by type: a checkbox is interactive, a hidden input is not",
      q: "agree",
      a: n("input", "agree", undefined, { tag: "input", inputType: "checkbox" }),
      b: n("input", "agree", undefined, { tag: "input", inputType: "hidden" }),
      delta: 2,
    },
    {
      name: "an explicit role= attribute still wins over the tag",
      q: "save",
      a: n("button", "save", undefined, { tag: "div", source: "dom" }),
      b: n("div", "save", undefined, { tag: "div", source: "dom" }),
      delta: 2,
    },
  ])("$name", ({ q, a, b, delta }) => {
    expect(scoreNode(a, q, [q])).toBe(scoreNode(b, q, [q]) + delta);
  });
});

describe("isCandidateRole — text and layout leaves are never a target", () => {
  it.each([
    {
      name: "rejects every Blink text leaf",
      nodes: ["StaticText", "InlineTextBox", "LineBreak", "ListMarker"].map((role) => ({ role })),
      expected: false,
    },
    {
      name: "rejects the document root, whose name is the page title",
      nodes: [{ role: "RootWebArea" }, { role: "WebArea" }],
      expected: false,
    },
    {
      name: "keeps a presentational role the page author addressed by test attribute",
      nodes: [{ role: "StaticText", testId: "price-total" }],
      expected: true,
    },
  ])("$name", ({ nodes, expected }) => {
    for (const node of nodes) expect(isCandidateRole(node), node.role).toBe(expected);
  });
});
