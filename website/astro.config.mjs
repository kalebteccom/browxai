// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

// The browxai documentation site, served at browxai.com.
// Static Astro + Starlight. The published content lives in
// src/content/docs/; internal working docs stay in the repo's docs/ tree
// and never ship here.
export default defineConfig({
  site: "https://browxai.com",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "browxai",
      description:
        "A browser built for agents. MCP-native, model-agnostic, agentic-first browser control on Playwright and CDP.",
      tagline: "A browser, built for agents.",
      // Fail the build on broken internal links or heading anchors, so dead
      // links can never ship. This is the build-time "error boundary" for a
      // static docs site.
      plugins: [starlightLinksValidator()],
      logo: {
        light: "./src/assets/mark-light.svg",
        dark: "./src/assets/mark-dark.svg",
      },
      components: {
        Footer: "./src/components/Footer.astro",
        Sidebar: "./src/components/Sidebar.astro",
      },
      favicon: "/favicon.svg",
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://browxai.com/og.png" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://browxai.com/og.png" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#0a0b0d" } },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/kalebteccom/browxai",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/kalebteccom/browxai/edit/main/website/",
      },
      customCss: [
        "@fontsource/poppins/500.css",
        "@fontsource/poppins/600.css",
        "@fontsource/poppins/700.css",
        "@fontsource/inter/400.css",
        "@fontsource/inter/500.css",
        "@fontsource/inter/600.css",
        "@fontsource/jetbrains-mono/400.css",
        "@fontsource/jetbrains-mono/500.css",
        "./src/styles/brand.css",
      ],
      expressiveCode: {
        themes: ["github-dark", "github-light"],
        styleOverrides: {
          borderRadius: "0.5rem",
          borderColor: "var(--browx-code-border)",
          codeFontFamily: "var(--browx-font-mono)",
        },
      },
      sidebar: [
        {
          label: "Start here",
          items: [{ label: "Getting started", slug: "getting-started" }],
        },
        {
          label: "Concepts",
          items: [
            { label: "What browxai is", slug: "concepts/overview" },
            { label: "The agent loop", slug: "concepts/the-agent-loop" },
            { label: "Sessions and lifecycle", slug: "concepts/sessions-and-lifecycle" },
            { label: "Capabilities and safety", slug: "concepts/capabilities-and-safety" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Configuration", slug: "guides/configuration" },
            { label: "Recipes", slug: "guides/recipes" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Tool reference", slug: "reference/tool-reference" },
            { label: "FAQ", slug: "reference/faq" },
          ],
        },
        {
          label: "Plugins",
          items: [
            { label: "Overview", slug: "plugins/overview" },
            { label: "Authoring", slug: "plugins/authoring" },
            { label: "Governance", slug: "plugins/governance" },
          ],
        },
        {
          label: "Security",
          items: [
            { label: "Threat model", slug: "security/threat-model" },
            { label: "Best practices", slug: "security/best-practices" },
          ],
        },
      ],
      lastUpdated: true,
    }),
  ],
});
