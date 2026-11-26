#!/usr/bin/env node
// Print the CHANGELOG.md section of one version, for the GitHub Release body.
// No dependencies, no build.
//
// The section is every line after `## [X.Y.Z] - YYYY-MM-DD` up to the next
// `## ` heading, trimmed. A tag name works as the version (`v0.22.0`). Exits 1
// when the version has no section or the section is empty, so a release never
// goes out with a blank body.
//
// Run: node scripts/changelog-section.mjs <version> [path to CHANGELOG.md]

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function section(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

const [arg, path = join(ROOT, "CHANGELOG.md")] = process.argv.slice(2);
if (!arg) {
  console.error("usage: changelog-section.mjs <version> [CHANGELOG.md]");
  process.exit(2);
}
const version = arg.replace(/^v/, "");
const body = section(readFileSync(path, "utf8"), version);
if (!body) {
  console.error(`changelog-section: no CHANGELOG section for ${version} in ${path}`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
