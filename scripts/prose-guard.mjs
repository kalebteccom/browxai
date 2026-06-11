#!/usr/bin/env node
// prose-guard: keep the docs reading like a person wrote them.
//
// Fails the build if any published page (website/src/content/**) contains an
// em dash, an en dash used as punctuation, or one of the stock "AI voice"
// tells. Code blocks and inline code are exempt, so real code samples are
// never touched. Run by `pnpm --filter @browxai/website build` and in CI.
//
// The rule is simple and on purpose: use a spaced hyphen ( - ) or rewrite
// the sentence. No exceptions list, no overrides. If the guard trips, fix
// the prose, not the guard.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const contentRoot = join(here, "..", "website", "src", "content");

// Stock LLM filler. Word-boundary, case-insensitive. Every one of these has
// a plainer replacement; that is the point.
const BANNED_TELLS = [
  "delve",
  "leverage",
  "seamless",
  "seamlessly",
  "effortless",
  "effortlessly",
  "unleash",
  "supercharge",
  "cutting-edge",
  "game-changer",
  "game-changing",
  "best-in-class",
  "world-class",
  "tapestry",
  "boasts",
  "in today's",
  "harness the power",
  "treasure trove",
  "it's important to note",
  "needless to say",
  "a testament to",
  "navigating the",
  "when it comes to",
  "at the end of the day",
];

const bannedRe = new RegExp(
  "\\b(" + BANNED_TELLS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
  "i",
);

/** Walk a directory tree and yield every markdown/mdx file. */
async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(md|mdx)$/.test(entry.name)) {
      yield full;
    }
  }
}

/** Strip inline code spans so code is never flagged. */
function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, "");
}

const violations = [];

for await (const file of walk(contentRoot)) {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  let inFence = false;
  let fenceMarker = "";

  lines.forEach((raw, i) => {
    const fenceMatch = raw.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (raw.includes(fenceMarker.repeat(3))) {
        inFence = false;
      }
      return;
    }
    if (inFence) return;

    const line = stripInlineCode(raw);
    const rel = relative(join(here, ".."), file);

    if (line.includes("—")) {
      violations.push({ rel, line: i + 1, kind: "em dash (—)", text: raw.trim() });
    }
    // En dash only flagged when surrounded by spaces (punctuation use), not
    // inside ranges like 2020-2024 written with a hyphen.
    if (/\s–\s/.test(line)) {
      violations.push({ rel, line: i + 1, kind: "en dash (–)", text: raw.trim() });
    }
    const tell = line.match(bannedRe);
    if (tell) {
      violations.push({ rel, line: i + 1, kind: `AI tell ("${tell[1]}")`, text: raw.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(`\nprose-guard: ${violations.length} issue(s) found.\n`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  ${v.kind}`);
    console.error(`    ${v.text.slice(0, 100)}`);
  }
  console.error(
    "\nFix: use a spaced hyphen ( - ) or rewrite the sentence. No em/en dashes, no filler.\n",
  );
  process.exit(1);
}

console.log("prose-guard: clean.");
