// Generate the published ports of the canonical docs into the Starlight content
// collection. The source of truth is the repo's docs/*.md (those files are
// referenced by code and AGENTS.md as canonical, agent-facing paths). This
// script derives the public-site HTML copies; the transform itself lives in
// doc-pipeline.mjs and is shared with the plaintext .md endpoint
// (src/pages/[...slug].md.ts).
//
// Runs as the first step of `dev` and `build`. The generated files are git-
// ignored (see .gitignore) so docs/ stays the single source of truth. Edit the
// source in docs/, never the generated file. The agent-only page
// (agent-guidance) is NOT generated here - it is served only as plaintext .md.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlPages, transformBody, q, SRC } from "./doc-pipeline.mjs";
import { toolReferenceOutputs } from "./tool-reference-pages.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "content", "docs");

// The generated files are git-ignored, so Starlight finds no git date for them.
// Use the last commit that touched the source docs/*.md instead. An empty
// answer (shallow clone, untracked file) leaves the date out.
const sourceDate = (src) => {
  try {
    const iso = execFileSync("git", ["log", "-1", "--format=%cI", "--", join(SRC, src)], {
      cwd: SRC,
      encoding: "utf8",
    }).trim();
    return iso ? iso.slice(0, 10) : "";
  } catch {
    return "";
  }
};

const BANNER = (src) =>
  `<!-- AUTO-GENERATED from docs/${src} by website/scripts/sync-docs.mjs. Edit the source, not this file. -->`;

function write(src, out, title, description, body) {
  const date = sourceDate(src);
  const updated = date ? `lastUpdated: ${date}\n` : "";
  const fm = `---\ntitle: ${q(title)}\ndescription: ${q(description)}\n${updated}---\n\n${BANNER(src)}\n\n`;
  const dest = join(OUT, out);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, fm + body);
}

let count = 0;
for (const p of htmlPages) {
  if (p.src === "tool-reference.md") {
    // One source file, many pages: an index plus one page per section. See
    // tool-reference-pages.mjs.
    const source = readFileSync(join(SRC, p.src), "utf8");
    const pages = toolReferenceOutputs(source, {
      indexOut: p.out,
      indexDescription: p.description,
    });
    for (const page of pages) write(p.src, page.out, page.title, page.description, page.body);
    count += pages.length;
    continue;
  }
  write(p.src, p.out, p.title, p.description, transformBody(p));
  count += 1;
}
console.log(`sync-docs: generated ${count} page(s).`);
