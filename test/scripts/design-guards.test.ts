// Proof that the static design guard fails when a violation returns. Each case
// plants one violation in an otherwise clean tree and asserts that
// scripts/check-design-rules.mjs exits 1 and names the rule. One clean tree
// asserts exit 0, so a guard that always fails cannot pass here either.
// scripts/check-layout.mjs needs a browser and is covered by the browser job.

import { afterEach, describe, expect, it } from "vitest";
import { cleanTrees, makeTree, runNode } from "./_guard-tree.js";

afterEach(cleanTrees);

const SCRIPT = "scripts/check-design-rules.mjs";
const SCRIPTS = [
  SCRIPT,
  "scripts/design-type-rules.mjs",
  "website/scripts/doc-pipeline.mjs",
  "website/scripts/lib/strip-code.mjs",
];
const DOCS = [
  "tool-reference",
  "threat-model",
  "security-best-practices-for-adopters",
  "plugins",
  "plugins-first-party",
  "plugin-authoring",
  "plugin-governance",
  "agent-guidance",
];
const PAGE = "website/src/content/docs/page.md";
const EXTRA = "website/src/styles/extra.css";

// Satisfies every rule: tokens, one content measure, the three layout guards
// and a reduced-motion guard for the one transition.
const BASE_CSS = `
.browx-copyable { white-space: nowrap; overflow-x: auto; min-height: var(--browx-tap); }
main:has(.browx-hero) { max-width: 1440px; margin-inline: auto; }
.sl-markdown-content { max-width: 60ch; }
.sl-markdown-content code { overflow-wrap: anywhere; }
.btn { padding: var(--space-2); transition: transform 120ms; }
.btn:hover { color: var(--text); }
.btn:active { color: var(--text); }
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
`;

function baseFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "README.md": "# browxai\n\nA clean sentence.\n",
    "website/public/llms.txt": "browxai\n\nA clean sentence.\n",
    "website/astro.config.mjs": "export default {};\n",
    "website/scripts/gen-og.mjs": "export {};\n",
    [PAGE]: "---\ntitle: Setup\n---\n\nA clean sentence.\n",
    "website/src/styles/brand.css": BASE_CSS,
  };
  for (const name of DOCS) files[`docs/${name}.md`] = "# Doc\n\nA clean sentence.\n";
  return files;
}

/** Run the guard over the clean tree with `files` merged in (null deletes a path). */
function check(overrides: Record<string, string | null> = {}) {
  const files = baseFiles();
  for (const [path, content] of Object.entries(overrides)) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  return runNode(makeTree(files, SCRIPTS), SCRIPT);
}

function expectRule(rule: string, overrides: Record<string, string | null>) {
  const { code, out } = check(overrides);
  expect(code).toBe(1);
  expect(out).toContain(`: ${rule}:`);
}

describe("check-design-rules: clean tree", () => {
  it("exits 0 on a tree with no violations", () => {
    const { code, out } = check();
    expect(out).toContain("check-design-rules: ok");
    expect(code).toBe(0);
  });
});

describe("check-design-rules: prose", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["em dash in site content", { [PAGE]: "A sentence — with a dash.\n" }],
    ["en dash in site content", { [PAGE]: "Pages 3–5 cover it.\n" }],
    ["spaced hyphen in prose", { [PAGE]: "Fast - and simple.\n" }],
    ["spaced hyphen in a title", { [PAGE]: "---\ntitle: Setup - install\n---\n\nBody.\n" }],
    ["em dash in the README", { "README.md": "Install — then run.\n" }],
    ["em dash in a published doc", { "docs/threat-model.md": "Scope — narrow.\n" }],
    ["em dash in llms.txt", { "website/public/llms.txt": "browxai — a tool.\n" }],
    ["em dash in an astro component", { "website/src/components/A.astro": "<p>a — b</p>\n" }],
    [
      "em dash in a source string",
      { "website/astro.config.mjs": 'export default { t: "a — b" };\n' },
    ],
  ];
  it.each(cases)("%s fails with no-dash", (_name, overrides) => {
    expectRule("no-dash", overrides);
  });

  it("keeps double-backtick spans from tripping the dash rule", () => {
    const page = [
      "Write ``a — b`` for a dash.",
      "Write ``a ` — b`` with a stray backtick.",
      "Run ``git log - x`` as is.",
      "Inline `c — d` too.",
      "",
    ].join("\n");
    const { code, out } = check({ [PAGE]: page });
    expect(out).toContain("check-design-rules: ok");
    expect(code).toBe(0);
  });

  it("still flags a dash outside the double-backtick span on the same line", () => {
    expectRule("no-dash", { [PAGE]: "Write ``a b`` — then stop.\n" });
  });

  it("skips fenced blocks", () => {
    const { code } = check({ [PAGE]: "```\na — b\n```\n" });
    expect(code).toBe(0);
  });
});

describe("check-design-rules: css", () => {
  const cases: Array<[string, string, string]> = [
    [
      "mono-outside-code",
      "monospace font on prose",
      ".note { font-family: ui-monospace, monospace; }",
    ],
    ["no-uppercase-tracking", "uppercase", ".label { text-transform: uppercase; }"],
    ["no-uppercase-tracking", "positive letter-spacing", ".label { letter-spacing: 0.1em; }"],
    ["no-gradient-glow", "gradient", ".hero { background: linear-gradient(red, blue); }"],
    ["no-gradient-glow", "backdrop-filter", ".bar { backdrop-filter: blur(8px); }"],
    ["no-gradient-glow", "accent box-shadow", ".card { box-shadow: 0 0 8px var(--accent); }"],
    ["no-gradient-glow", "glow selector", ".glow { color: var(--text); }"],
    ["no-pure-colour", "#fff literal", ".x { color: #fff; }"],
    ["no-pure-colour", "black keyword", ".x { background: black; }"],
    ["hover-without-active", "hover with no :active", ".link:hover { color: var(--text); }"],
    ["layout-transition", "width transition", ".x { transition: width 200ms; }"],
    ["spacing-token", "off-token padding", ".x { padding: 13px; }"],
    ["spacing-token", "off-token gap", ".x { gap: 0.9rem; }"],
    ["flagged-font", "Inter in a font stack", "body { font-family: Inter, sans-serif; }"],
    ["tight-leading", "tight line-height", ".sl-markdown-content p { line-height: 1.1; }"],
    ["tight-leading", "tight body token", ":root { --sl-line-height: 1.2; }"],
    ["measure-range", "measure over 64ch", ".sl-markdown-content { max-width: 90ch; }"],
    ["measure-range", "measure under 55ch", ".sl-markdown-content { max-width: 40ch; }"],
  ];
  it.each(cases)("%s: %s", (rule, _name, css) => {
    expectRule(rule, { [EXTRA]: css });
  });

  it("allows a mono font on a code selector", () => {
    const { code } = check({ [EXTRA]: "pre { font-family: ui-monospace, monospace; }\n" });
    expect(code).toBe(0);
  });

  it("flags a transition when no prefers-reduced-motion guard exists", () => {
    const css = BASE_CSS.replace(/@media[^\n]*\n?/, "");
    expectRule("layout-transition", { "website/src/styles/brand.css": css });
  });

  it("flags a missing 55 to 64ch content cap", () => {
    const css = BASE_CSS.replace(".sl-markdown-content { max-width: 60ch; }", "");
    expectRule("measure-range", { "website/src/styles/brand.css": css });
  });

  it("flags a missing layout guard", () => {
    const css = BASE_CSS.replace(".sl-markdown-content code { overflow-wrap: anywhere; }", "");
    expectRule("code-wrap", { "website/src/styles/brand.css": css });
  });
});
