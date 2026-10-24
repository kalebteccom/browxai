import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

// Pages under reference/, security/ and plugins/ are generated from docs/*.md
// by scripts/sync-docs.mjs and git-ignored, so the default edit link (which
// points into website/src/content/docs/) would 404 on GitHub. Point those
// pages at the file that is actually edited.
const EDIT_BASE = "https://github.com/kalebteccom/browxai/edit/main/docs/";
const SOURCES: Record<string, string> = {
  "reference/tool-reference": "tool-reference.md",
  "security/threat-model": "threat-model.md",
  "security/best-practices": "security-best-practices-for-adopters.md",
  "plugins/overview": "plugins.md",
  "plugins/first-party": "plugins-first-party.md",
  "plugins/authoring": "plugin-authoring.md",
  "plugins/governance": "plugin-governance.md",
};

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const source = SOURCES[route.entry.id.replace(/\.(md|mdx)$/, "")];
  if (source && route.editUrl) route.editUrl = new URL(EDIT_BASE + source);
});
