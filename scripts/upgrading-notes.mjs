#!/usr/bin/env node
// Write dist/upgrading.json, the Upgrading notes of every released version, from
// CHANGELOG.md. The npm tarball carries no CHANGELOG, so `browxai runtime notes`
// and the runtime updater read this file instead. `pnpm build` runs it.
// No dependencies.
//
// Per version (a `## [X.Y.Z] - date` section) the notes are, in CHANGELOG order:
//
//   - each paragraph that starts with `**Upgrading` (`**Upgrading from 0.21.0.**`,
//     `**Upgrading: <title>.**`), with a fenced code block that follows it;
//   - in each list entry, the text from `**Upgrading.**` or a sentence that starts
//     with `Upgrading:` to the end of the entry.
//
// A paragraph whose text after the bold lead starts with "Nothing to do." gives
// no note, and a version with no notes gets no key.
//
// Output: {"schemaVersion":1,"notes":{"<version>":"<notes>"}}, newest first.
//
// Run: node scripts/upgrading-notes.mjs [CHANGELOG.md] [out.json]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const UPGRADING_SCHEMA_VERSION = 1;

const SECTION = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/;
const LEAD = /^\*\*Upgrading[^*]*\*\*\s*/;
const IN_ENTRY = /\*\*Upgrading\.\*\*|(?<=[.!?:]\s)Upgrading:/;

/** The lines of each released section, keyed by version, newest first. */
function sections(lines) {
  const out = [];
  let current;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const m = SECTION.exec(line);
      current = m ? { version: m[1], lines: [] } : undefined;
      if (current) out.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return out;
}

/** Blocks separated by blank lines. A fenced code block is one block. */
function blocks(lines) {
  const out = [];
  let block = [];
  let fenced = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (!fenced && line.trim() === "") {
      if (block.length) out.push(block);
      block = [];
      continue;
    }
    block.push(line);
  }
  if (block.length) out.push(block);
  return out;
}

/** The list entries of a block: a line that starts with `- ` opens one, an
 *  indented line continues it. */
function entries(block) {
  const out = [];
  for (const line of block) {
    if (/^[-*] /.test(line)) out.push(line.slice(2));
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += " " + line.trim();
  }
  return out;
}

const nothingToDo = (paragraph) => paragraph.replace(LEAD, "").startsWith("Nothing to do.");

function notesOf(lines) {
  const out = [];
  const all = blocks(lines);
  for (let i = 0; i < all.length; i++) {
    const block = all[i];
    const text = block.join("\n").trim();
    if (LEAD.test(text)) {
      if (nothingToDo(text)) continue;
      const next = all[i + 1];
      const code = next && next[0].trimStart().startsWith("```") ? next.join("\n") : undefined;
      out.push(code ? `${text}\n\n${code}` : text);
      if (code) i++;
      continue;
    }
    for (const entry of entries(block)) {
      const m = IN_ENTRY.exec(entry);
      if (m) out.push(entry.slice(m.index).trim());
    }
  }
  return out;
}

/** `{ version: notes }` for every released version with Upgrading notes. */
export function extractUpgradingNotes(changelog) {
  const notes = {};
  for (const { version, lines } of sections(changelog.split(/\r?\n/))) {
    const found = notesOf(lines);
    if (found.length) notes[version] = found.join("\n\n");
  }
  return notes;
}

export function upgradingJson(changelog) {
  const doc = { schemaVersion: UPGRADING_SCHEMA_VERSION, notes: extractUpgradingNotes(changelog) };
  return JSON.stringify(doc, null, 2) + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [from = join(ROOT, "CHANGELOG.md"), to = join(ROOT, "dist", "upgrading.json")] =
    process.argv.slice(2);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, upgradingJson(readFileSync(from, "utf8")));
}
