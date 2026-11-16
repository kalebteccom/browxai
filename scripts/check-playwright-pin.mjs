#!/usr/bin/env node
// Guard for the browser-install pin in the docs. No dependencies, no build.
//
// A newcomer copies `npx playwright-core@X.Y.Z install chromium` from the docs.
// If X.Y.Z is not the playwright-core that pnpm-lock.yaml resolves, they download
// a browser build the installed package will not launch. Every pin in README.md,
// the site content, docs/ and harness/ must equal the resolved version.
//
// Skipped: CHANGELOG files (history), docs/rfcs and docs/ai-context (not adopter
// text), node_modules and dist.
//
// Run: node scripts/check-playwright-pin.mjs   (exit 1 with one line per finding)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["README.md", "website/src/content", "docs", "harness"];
const SKIP_DIRS = new Set(["node_modules", "dist", "rfcs", "ai-context"]);
const TEXT_EXT = /\.mdx?$/;
const PIN = /playwright-core@(\d+\.\d+\.\d+(?:-[\w.]+)?)/g;

// The version the root importer resolves for playwright-core, e.g. `1.64.1` from
// `version: 1.64.1` (a peer suffix such as `(zod@4)` is cut off).
function resolvedVersion(lock) {
  const start = lock.indexOf("\nimporters:\n\n  .:\n");
  if (start < 0) return undefined;
  const rest = lock.slice(start + "\nimporters:\n\n  .:\n".length);
  const end = rest.search(/\n {2}\S/);
  const block = end < 0 ? rest : rest.slice(0, end);
  return /\n {6}playwright-core:\n {8}specifier: .*\n {8}version: (\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(
    `\n${block}`,
  )?.[1];
}

function files(rel, out = []) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) return out;
  if (TEXT_EXT.test(rel)) return [...out, rel];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files(child, out);
    } else if (TEXT_EXT.test(entry.name) && !/^CHANGELOG/i.test(entry.name)) {
      out.push(child);
    }
  }
  return out;
}

function main() {
  const lockPath = join(ROOT, "pnpm-lock.yaml");
  const expected = existsSync(lockPath)
    ? resolvedVersion(readFileSync(lockPath, "utf8"))
    : undefined;
  if (expected === undefined) {
    console.error(
      "check-playwright-pin: pnpm-lock.yaml has no resolved playwright-core for the root package",
    );
    process.exitCode = 1;
    return;
  }
  const problems = [];
  let pins = 0;
  const list = SCAN.flatMap((rel) => files(rel));
  for (const file of list) {
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((text, i) => {
        for (const m of text.matchAll(PIN)) {
          pins += 1;
          if (m[1] !== expected) {
            problems.push(
              `${file}:${i + 1}: pins playwright-core@${m[1]}, pnpm-lock.yaml resolves ${expected}; use playwright-core@${expected}`,
            );
          }
        }
      });
  }
  if (problems.length > 0) {
    console.error(`check-playwright-pin: ${problems.length} stale pin(s)`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("  A playwright-core bump must update these pins in the same change.");
    process.exitCode = 1;
    return;
  }
  console.log(`check-playwright-pin: ok, ${pins} pin(s) in ${list.length} files, all ${expected}`);
}

main();
