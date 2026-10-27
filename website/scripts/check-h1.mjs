#!/usr/bin/env node
// Fails when a built page under the given directory has anything but one <h1>.
//
//   node scripts/check-h1.mjs dist
//
// Runs as the last step of the website build. Scripts, styles, templates and
// comments are stripped before counting, and meta-refresh redirect stubs are
// skipped.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "dist");

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith(".html")) yield path;
  }
}

const strip = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, "");

const failures = [];
let pages = 0;
for (const file of htmlFiles(root)) {
  const html = strip(readFileSync(file, "utf8"));
  if (/http-equiv=["']?refresh/i.test(html)) continue;
  pages += 1;
  const count = (html.match(/<h1[\s>]/gi) ?? []).length;
  if (count !== 1) failures.push(`${relative(root, file)}: ${count} h1`);
}

if (pages === 0) {
  console.error(`check-h1: no html pages under ${root}`);
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`check-h1: every page needs exactly one h1\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`check-h1: ${pages} pages, one h1 each`);
