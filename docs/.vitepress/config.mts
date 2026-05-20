import { defineConfig } from "vitepress";

// The documentation site — built from docs/ and deployed to GitHub Pages.
// Only the public-facing pages are built into the site; the internal working
// docs (adoption reports, the asks ledger, phase-design notes) are excluded
// from the build via `srcExclude` — they remain in the repo, just not on the
// published site.
export default defineConfig({
  title: "browxai",
  description: "MCP-native, model-agnostic, agentic-first browser-control server.",
  base: "/browxai/",
  cleanUrls: true,
  lastUpdated: true,
  // The reference pages are repo markdown that also link to source paths /
  // internal docs not built into the site — don't fail the build on those.
  ignoreDeadLinks: true,

  srcExclude: [
    "adoption-report-*.md",
    "first-consumer-asks.md",
    "phase-*.md",
    "divergence-notes.md",
    "site-docs-lifecycle-port-plan.md",
    "wishlist-*.md",
  ],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Tool reference", link: "/tool-reference" },
      { text: "Security", link: "/threat-model" },
    ],
    sidebar: [
      {
        text: "Documentation",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "Tool reference", link: "/tool-reference" },
          { text: "Security & threat model", link: "/threat-model" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/kalebteccom/browxai" },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/kalebteccom/browxai/edit/main/docs/:path",
    },
  },
});
