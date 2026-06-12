// Generate the published ports of the canonical docs into the Starlight
// content collection. The source of truth is the repo's docs/*.md (those files
// are referenced by code and AGENTS.md as canonical, agent-facing paths). This
// script derives the public-site copies: it converts em and en dashes to the
// spaced-hyphen house style (outside code), drops the duplicate H1, rewrites
// internal links to the site IA, and adds Starlight frontmatter.
//
// Runs as the first step of `dev` and `build`. The generated files are git-
// ignored (see .gitignore) so docs/ stays the single source of truth. Edit the
// source in docs/, never the generated file.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "..", "docs");
const OUT = join(here, "..", "src", "content", "docs");

const linkMap = [
  [/\]\(\/tool-reference\/?\)/g, "](/reference/tool-reference/)"],
  [/\]\(\/threat-model\/?\)/g, "](/security/threat-model/)"],
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

/** Convert em/en dashes to spaced hyphens, skipping fenced code blocks. */
function convertDashes(text) {
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

const q = (s) => `"${s.replace(/"/g, '\\"')}"`;

function port({ src, out, title, description }) {
  let text = readFileSync(join(SRC, src), "utf8");
  text = convertDashes(text);
  for (const [re, to] of linkMap) text = text.replace(re, to);
  // Repo-relative links (valid inside docs/, dead on the published site) point
  // at repo root, so rewrite them to GitHub. Directories -> tree, files -> blob.
  text = text.replace(/\]\(\.\.\/([^)]+)\)/g, (_, p) => {
    const kind = p.endsWith("/") ? "tree" : "blob";
    return `](https://github.com/kalebteccom/browxai/${kind}/main/${p.replace(/\/$/, "")})`;
  });
  text = text.replace(/^#\s+.*\n+/, ""); // drop the H1; the frontmatter title is the H1
  const banner = `<!-- AUTO-GENERATED from docs/${src} by website/scripts/sync-docs.mjs. Edit the source, not this file. -->`;
  const fm = `---\ntitle: ${q(title)}\ndescription: ${q(description)}\n---\n\n${banner}\n\n`;
  const dest = join(OUT, out);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, fm + text.trimStart());
}

const pages = [
  {
    src: "tool-reference.md",
    out: "reference/tool-reference.md",
    title: "Tool reference",
    description:
      "Every browxai tool: inputs, outputs, the configuration and session model, capabilities, and the stability policy.",
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

for (const p of pages) port(p);
console.log(`sync-docs: generated ${pages.length} page(s).`);
