#!/usr/bin/env node
// Static copy-rule guard for user-visible docs text. No dependencies, no build.
//
//   banned-word       filler words the house voice never uses (see BANNED_WORDS).
//   contrast-closer   "rather than", "not just", "not merely", "isn't about".
//
// Scope: the published docs sources, README, llms.txt, and the site content and
// components. Fenced blocks and inline code are skipped, so a literal parameter
// name or code sample never trips a rule. Triplet and negation cadence stay a
// review matter; they are too noisy to fail a build on.
//
// Run: node scripts/check-copy-rules.mjs   (exit 1 with one line per finding)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// Docs sources the site publishes (website/scripts/doc-pipeline.mjs).
const PUBLISHED_DOCS = [
  "agent-guidance.md",
  "plugin-authoring.md",
  "plugin-governance.md",
  "plugins-first-party.md",
  "plugins.md",
  "security-best-practices-for-adopters.md",
  "threat-model.md",
  "tool-reference.md",
].map((name) => join(ROOT, "docs", name));

const SITE_DIRS = [
  join(ROOT, "website", "src", "content"),
  join(ROOT, "website", "src", "components"),
];
const SINGLE_FILES = [join(ROOT, "README.md"), join(ROOT, "website", "public", "llms.txt")];
const TEXT_EXT = /\.(md|mdx|astro|txt)$/;
const FENCE = /^\s*(```+|~~~+)/;

const BANNED_WORDS =
  /\b(robust(ly|ness)?|seamless(ly)?|comprehensive(ly)?|leverag(e|es|ed|ing)|delv(e|es|ed|ing)|crucial(ly)?|pivotal|landscape|journey|testament|ultimately|in short|that said|worth noting|dive deep)\b/i;
const CONTRAST_CLOSER = /\b(rather than|not just|not merely|isn['’]t about)\b/i;

const findings = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".astro") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (TEXT_EXT.test(name)) out.push(path);
  }
  return out;
}

function checkFile(file) {
  let inFence = false;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const prose = lines[i].replace(/`[^`]*`/g, "");
    const rules = [
      ["banned-word", BANNED_WORDS],
      ["contrast-closer", CONTRAST_CLOSER],
    ];
    for (const [rule, pattern] of rules) {
      const match = prose.match(pattern);
      if (match) findings.push(`${relative(ROOT, file)}:${i + 1}: ${rule}: "${match[0]}"`);
    }
  }
}

const files = [...PUBLISHED_DOCS, ...SINGLE_FILES, ...SITE_DIRS.flatMap((dir) => walk(dir))];
for (const file of files) checkFile(file);

if (findings.length > 0) {
  console.error(findings.join("\n"));
  console.error(`\ncheck-copy-rules: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log(`check-copy-rules: ${files.length} files clean`);
