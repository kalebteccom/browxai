import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

type Rules = Record<string, Record<string, string>>;

/** `[[headers]]` blocks of netlify.toml: for = "...", then `Key = "value"` lines. */
function fromToml(text: string): Rules {
  const rules: Rules = {};
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const path = /^for\s*=\s*"([^"]+)"/.exec(line);
    if (path) {
      current = path[1]!;
      rules[current] = {};
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z-]*)\s*=\s*"([^"]*)"$/.exec(line);
    if (kv && current && !line.startsWith("for")) rules[current]![kv[1]!] = kv[2]!;
  }
  return rules;
}

/** Netlify `_headers`: a path line, then indented `Key: value` lines. */
function fromHeadersFile(text: string): Rules {
  const rules: Rules = {};
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = raw.trim();
      rules[current] = {};
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z-]*):\s*(.+)$/.exec(raw.trim());
    if (kv && current) rules[current]![kv[1]!] = kv[2]!.trim();
  }
  return rules;
}

describe("docs site headers", () => {
  it("website/public/_headers carries the same rules as netlify.toml", () => {
    const toml = fromToml(readFileSync(join(root, "netlify.toml"), "utf8"));
    const file = fromHeadersFile(readFileSync(join(root, "website/public/_headers"), "utf8"));
    expect(Object.keys(toml).length).toBeGreaterThan(0);
    expect(file).toEqual(toml);
  });
});
