// Plaintext .md twin of every doc page, plus the agent-only pages.
//
// llms.txt links here (e.g. /reference/tool-reference.md) so agents read clean
// markdown, including the "For agents" guidance that the rehype strip removes
// from the rendered HTML. Internal links are rewritten to their .md form so the
// whole agent-facing surface stays self-consistent.
//
// Agent-only pages (agent-guidance) exist ONLY here - they have no HTML
// rendering and are absent from the human sidebar.
import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentOnlyPages, transformText } from "../../scripts/doc-pipeline.mjs";

// At build time the working directory is the website package; the repo root is
// its parent and the canonical sources live in docs/. Resolving from cwd (not
// import.meta.url) keeps reads correct when Astro bundles this endpoint for
// prerendering.
const DOCS_ROOT = join(process.cwd(), "..", "docs");

// Pages that are not part of the markdown surface.
const SKIP = new Set(["index", "404"]);

type PageProps = { title: string; body: string };

export const getStaticPaths = (async () => {
  const docs = await getCollection("docs");
  const fromHtml = docs
    .map((e) => ({ ...e, slug: e.id.replace(/\.(md|mdx)$/, "") }))
    .filter((e) => !SKIP.has(e.slug))
    .map((e) => ({
      params: { slug: e.slug },
      props: { title: e.data.title, body: e.body ?? "" } as PageProps,
    }));
  const agentOnly = agentOnlyPages.map((p) => {
    const raw = readFileSync(join(DOCS_ROOT, p.src), "utf8");
    return {
      params: { slug: p.out.replace(/\.mdx?$/, "") },
      props: { title: p.title, body: transformText(raw) } as PageProps,
    };
  });
  return [...fromHtml, ...agentOnly];
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => {
  const { title, body } = props as PageProps;
  const md = `# ${title}\n\n${toMarkdownLinks(stripBanner(stripFrontmatter(body))).trim()}\n`;
  return new Response(md, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};

/** Drop a leading YAML frontmatter block, if present (entry.body has none). */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Drop the sync-docs auto-generated banner comment. */
function stripBanner(text: string): string {
  return text.replace(/<!-- AUTO-GENERATED[\s\S]*?-->\n*/, "");
}

/**
 * Rewrite site-internal page links (trailing-slash routes) to their .md twin,
 * so links between agent-facing markdown files stay in the markdown surface.
 * Leaves anchors, asset paths (no trailing slash), and external links alone.
 */
function toMarkdownLinks(text: string): string {
  return text.replace(
    /\]\((\/[^)#\s]+?)\/(#[^)\s]*)?\)/g,
    (_m, path, frag) => `](${path}.md${frag ?? ""})`,
  );
}
