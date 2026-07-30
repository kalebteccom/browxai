// Shared doc-porting pipeline. Two consumers import from here:
//
//   - sync-docs.mjs      generates the published Starlight pages (HTML twin)
//                        from the canonical docs/*.md into the content collection.
//   - src/pages/[...slug].md.ts  serves the plaintext .md twin of every page
//                        (linked from llms.txt) and the agent-only pages, which
//                        have no HTML rendering at all.
//
// The transform converts em/en dashes to the spaced-hyphen house style (outside
// code), drops the duplicate H1, rewrites internal links to the site IA, and
// points repo-relative or agent-only links at GitHub.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");
export const SRC = join(ROOT, "docs");
export const GITHUB = "https://github.com/kalebteccom/browxai";

// Internal-link rewrites applied to the published copies. Links to agent-only
// pages (agent-guidance) point at the canonical GitHub source: the page has no
// HTML route, so the link validator would otherwise fail.
export const linkMap = [
  [/\]\(\/tool-reference\/?\)/g, "](/reference/tool-reference/)"],
  [/\]\(\/threat-model\/?\)/g, "](/security/threat-model/)"],
  [/\]\(\.\/tool-reference\.md\)/g, "](/reference/tool-reference/)"],
  [/\]\(\.\/threat-model\.md\)/g, "](/security/threat-model/)"],
  [/\]\(\.\/agent-guidance\.md\)/g, `](${GITHUB}/blob/main/docs/agent-guidance.md)`],
  [/\]\(\/guides\/agent-guidance\/?\)/g, `](${GITHUB}/blob/main/docs/agent-guidance.md)`],
  [/\]\(\/getting-started\/?\)/g, "](/getting-started/)"],
  [/\]\(\.\/plugins\.md\)/g, "](/plugins/overview/)"],
  [/\]\(\.\/plugins-first-party\.md\)/g, "](/plugins/first-party/)"],
  [/\]\(\.\/plugin-authoring\.md\)/g, "](/plugins/authoring/)"],
  [/\]\(\.\/plugin-governance\.md\)/g, "](/plugins/governance/)"],
  [/\]\(\/plugins\/?\)/g, "](/plugins/overview/)"],
  [/\]\(\/plugins-first-party\/?\)/g, "](/plugins/first-party/)"],
  [/\]\(\/plugin-authoring\/?\)/g, "](/plugins/authoring/)"],
  [/\]\(\/plugin-governance\/?\)/g, "](/plugins/governance/)"],
  [/\]\(\/security-best-practices-for-adopters\/?\)/g, "](/security/best-practices/)"],
];

// Pages rendered as HTML on the site (and mirrored as a plaintext .md twin).
// Each entry: src (file under docs/), out (content-collection path),
// title/description (frontmatter).
export const htmlPages = [
  {
    src: "tool-reference.md",
    out: "reference/tool-reference.md",
    title: "Tool reference",
    description:
      "Every browxai tool: inputs, outputs, example calls, the configuration and session model, capabilities, and the stability policy.",
  },
  {
    src: "threat-model.md",
    out: "security/threat-model.md",
    title: "Threat model",
    description:
      "browxai's capability model, its trust boundaries, what it defends against, and what it deliberately does not.",
  },
  {
    src: "security-best-practices-for-adopters.md",
    out: "security/best-practices.md",
    title: "Security best practices",
    description:
      "Hardening browxai for adopters: capability scoping, origin policy, CI posture, and secret handling.",
  },
  {
    src: "plugins.md",
    out: "plugins/overview.md",
    title: "Plugins overview",
    description:
      "The browxai plugin runtime: install model, the reproducibility surface, lifecycle, and namespacing.",
  },
  {
    src: "plugins-first-party.md",
    out: "plugins/first-party.md",
    title: "First-party plugins",
    description:
      "The @browxai plugin set - the example plugin plus the figma, tldraw, and excalidraw canvas adapters: every tool, args, return shapes, and error envelopes.",
  },
  {
    src: "plugin-authoring.md",
    out: "plugins/authoring.md",
    title: "Authoring plugins",
    description:
      "Write a browxai plugin: the manifest, tool registration, capabilities, validation, and publishing.",
  },
  {
    src: "plugin-governance.md",
    out: "plugins/governance.md",
    title: "Plugin governance",
    description: "How browxai plugins are reviewed, trust-tagged, and maintained over time.",
  },
];

// Agent-facing pages. These never render as HTML and are not in the human
// sidebar - they are served only as plaintext .md (linked from llms.txt) so a
// coding agent driving browxai gets the full footgun map, while the rendered
// site stays focused on the end user.
export const agentOnlyPages = [
  {
    src: "agent-guidance.md",
    out: "guides/agent-guidance.md",
    title: "Agent guidance",
    description:
      "The reach-for-this-not-that map for agents driving browxai: eval_js vs the curated surface, scoped reads, screenshot budgets, flake_check, BYOB cleanup, and capability minimalism.",
  },
];

/** Convert em/en dashes to spaced hyphens, skipping fenced code blocks. */
export function convertDashes(text) {
  let inFence = false;
  return text
    .split("\n")
    .map((raw) => {
      if (/^\s*(```+|~~~+)/.test(raw)) {
        inFence = !inFence;
        return raw;
      }
      if (inFence) return raw;
      return raw.replace(/ ?— ?/g, " - ").replace(/ – /g, " - ").replace(/–/g, "-");
    })
    .join("\n");
}

export const q = (s) => `"${s.replace(/"/g, '\\"')}"`;

/**
 * Apply the full transform pipeline to raw source text, returning the page body
 * (no frontmatter, no banner). H1 is dropped - the title comes from frontmatter
 * (HTML) or is prepended by the .md endpoint. Pure (no file IO) so the .md
 * endpoint can call it on text it read itself at build time.
 */
export function transformText(text) {
  text = convertDashes(text);
  for (const [re, to] of linkMap) text = text.replace(re, to);
  // Repo-relative links (valid inside docs/, dead on the published site) point
  // at repo root, so rewrite them to GitHub. Directories -> tree, files -> blob.
  text = text.replace(/\]\(\.\.\/([^)]+)\)/g, (_, p) => {
    const kind = p.endsWith("/") ? "tree" : "blob";
    return `](${GITHUB}/${kind}/main/${p.replace(/\/$/, "")})`;
  });
  text = text.replace(/^#\s+.*\n+/, ""); // drop the H1
  return text.trimStart();
}

/** Read a source file (resolved against docs/) and transform it. */
export function transformBody(page) {
  return transformText(readFileSync(join(SRC, page.src), "utf8"));
}
