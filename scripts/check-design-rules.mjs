#!/usr/bin/env node
// Static design-rule guard (G1) for the docs site. No dependencies, no build.
//
//   no-dash                  em and en dashes (and a spaced hyphen standing in
//                            for one) in user-visible copy: the published docs,
//                            README, llms.txt, site content and components.
//                            Fenced blocks and inline code are skipped.
//   mono-outside-code        a monospace font-family in website/src/styles on a
//                            selector that is not real code.
//   no-uppercase-tracking    text-transform: uppercase or positive
//                            letter-spacing on a selector that is not real code.
//
// Run: node scripts/check-design-rules.mjs   (exit 1 with one line per finding)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SITE = join(ROOT, "website");

// Selectors whose text is real code: code panes, inline code, shell commands.
const CODE_SELECTOR = /(^|[^\w-])(pre|code|kbd|samp)([^\w-]|$)|\.browx-install\b|\.browx-snap\b/;
const MONO_FONT = /mono|--sl-font-code|ui-monospace|courier/i;
const DASH = /[–—]/;
const SPACED_HYPHEN = /\w[)\]`"']? - [\w`("']/;
const FENCE = /^\s*(```+|~~~+)/;
const TEXT_EXT = /\.(md|mdx|astro|txt|json)$/;
const CODE_EXT = /\.(mjs|ts|js)$/;

const findings = [];
const report = (file, line, rule, detail) =>
  findings.push(`${relative(ROOT, file)}:${line}: ${rule}: ${detail}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".astro") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Lines of prose: fenced blocks and inline code removed, numbering kept. */
function* proseLines(text) {
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    yield [i + 1, lines[i].replace(/`[^`]*`/g, "``")];
  }
}

function checkProse(file, { spacedHyphen }) {
  for (const [n, line] of proseLines(readFileSync(file, "utf8"))) {
    if (DASH.test(line)) report(file, n, "no-dash", line.trim().slice(0, 90));
    else if (spacedHyphen && SPACED_HYPHEN.test(line.replace(/^\s*[-*]\s/, ""))) {
      if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(line))
        report(file, n, "no-dash", line.trim().slice(0, 90));
    }
  }
}

/** Source files: only string-ish lines count, comments are skipped. */
function checkSource(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    const code = line.replace(/\s\/\/ .*$/, "");
    if (DASH.test(code)) report(file, i + 1, "no-dash", t.slice(0, 90));
  });
}

function checkCss(file) {
  const raw = readFileSync(file, "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rule.exec(css))) {
    const selector = m[1].trim();
    if (CODE_SELECTOR.test(selector)) continue;
    const line = css.slice(0, m.index + m[0].indexOf("{")).split("\n").length;
    for (const decl of m[2].split(";")) {
      const [prop, ...rest] = decl.split(":");
      const name = prop.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (name === "font-family" && MONO_FONT.test(value)) {
        report(
          file,
          line,
          "mono-outside-code",
          `${selector.replace(/\s+/g, " ")} { font-family: ${value} }`,
        );
      } else if (name === "text-transform" && /uppercase/.test(value)) {
        report(
          file,
          line,
          "no-uppercase-tracking",
          `${selector.replace(/\s+/g, " ")} { text-transform: uppercase }`,
        );
      } else if (
        name === "letter-spacing" &&
        /^\+?(\d*\.)?\d+(em|rem|px)$/.test(value) &&
        parseFloat(value) > 0
      ) {
        report(
          file,
          line,
          "no-uppercase-tracking",
          `${selector.replace(/\s+/g, " ")} { letter-spacing: ${value} }`,
        );
      }
    }
  }
}

async function publishedDocs() {
  const pipeline = await import(pathToFileURL(join(SITE, "scripts", "doc-pipeline.mjs")).href);
  return [...pipeline.htmlPages, ...pipeline.agentOnlyPages].map((p) => join(pipeline.SRC, p.src));
}

async function main() {
  // Published docs and README: sentences in markdown.
  for (const file of [...(await publishedDocs()), join(ROOT, "README.md")])
    checkProse(file, { spacedHyphen: true });

  // llms.txt is plain prose.
  checkProse(join(SITE, "public", "llms.txt"), { spacedHyphen: true });

  // Site content, components and config: copy lives in these.
  for (const file of walk(join(SITE, "src"))) {
    if (TEXT_EXT.test(file)) checkProse(file, { spacedHyphen: /\.(md|mdx)$/.test(file) });
    else if (/\.css$/.test(file) && file.includes("styles")) checkCss(file);
    else if (CODE_EXT.test(file)) checkSource(file);
  }
  checkSource(join(SITE, "astro.config.mjs"));
  checkSource(join(SITE, "scripts", "gen-og.mjs"));

  if (findings.length) {
    console.error(findings.join("\n"));
    console.error(`\ncheck-design-rules: ${findings.length} finding(s)`);
    process.exit(1);
  }
  console.log("check-design-rules: ok");
}

await main();
