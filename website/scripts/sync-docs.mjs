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
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlPages, transformBody, q } from "./doc-pipeline.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "content", "docs");

for (const p of htmlPages) {
  const body = transformBody(p);
  const banner = `<!-- AUTO-GENERATED from docs/${p.src} by website/scripts/sync-docs.mjs. Edit the source, not this file. -->`;
  const fm = `---\ntitle: ${q(p.title)}\ndescription: ${q(p.description)}\n---\n\n${banner}\n\n`;
  const dest = join(OUT, p.out);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, fm + body);
}
console.log(`sync-docs: generated ${htmlPages.length} page(s).`);
