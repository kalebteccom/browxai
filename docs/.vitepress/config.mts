import { defineConfig } from "vitepress";

// The documentation site — built from docs/ and deployed to GitHub Pages.
// docs/ holds only public-facing pages (the landing/guide + tool-reference +
// threat-model); internal working docs live in the portfolio repo, not here.
export default defineConfig({
  title: "browxai",
  description: "MCP-native, model-agnostic, agentic-first browser-control server.",
  base: "/browxai/",
  cleanUrls: true,
  lastUpdated: true,
  // The reference pages are repo markdown that also link to source paths —
  // don't fail the build on those.
  ignoreDeadLinks: true,

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
