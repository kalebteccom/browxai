// Pure helpers for the manual first-run workflow: text clipping, the token estimate, the size budget and the printed block.
// No I/O except `emit` (console). test/scripts/first-run-block.test.ts covers the pure functions.
//
// OUTPUT CONTRACT: every section prints one block between `===== FIRST-RUN BEGIN =====` and `===== FIRST-RUN END =====`:
// the plain text, then the same text again as `<TAG>|n|<line>` lines in chunks of about 1.5 KB, so a log service that
// drops a long line still leaves it readable. The text of the four sections together stays under 14 KB (BUDGETS), so all
// four blocks (text and chunked copy) stay under 30 KB.

export const BEGIN = "===== FIRST-RUN BEGIN =====";
export const END = "===== FIRST-RUN END =====";
export const CHUNK_BYTES = 1500;
export const MAX_LINE = 130;

/** Plain-text budget in bytes of each section's block. The sum is at most 13800: the text and its chunked copy print twice,
 *  plus the chunk prefixes and the markers, and that has to stay under 30 KB. A section that needs more takes it from another. */
export const BUDGETS = { install: 5800, snapshot: 2100, sizes: 2500, paths: 3400 };

// Glyphs doctor and init print, shown as plain words so the log stays ASCII.
const GLYPHS = { "✓": "OK", "✗": "NO", "⚠": "WARN", "−": "-" };
// Whitespace (newline, tab, no-break space) becomes one space before the non-ASCII sweep, else a newline would print as "?".
// Zero-width characters and variation selectors carry no text and are dropped.
export const ascii = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\u200b-\u200f\u2060\ufeff]|[\ufe00-\ufe0f]/g, "")
    .replace(/[✓✗⚠−]/g, (g) => GLYPHS[g])
    .replace(/[^\x20-\x7e]/g, "?");

/** One line, ASCII, at most n characters. */
export const clip = (text, n = MAX_LINE) => {
  const flat = ascii(text).replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 3)}...` : flat;
};
export const bytes = (s) => Buffer.byteLength(s, "utf8");

/** Characters divided by 4, rounded up. An estimate: it is not a tokenizer. */
export const estTokens = (chars) => Math.ceil(chars / 4);

export const secs = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;

/** Human size from a byte count. */
export function size(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** The first `lines` lines of a command's output, each clipped, with a marker when lines were cut. */
export function excerpt(output, lines, width = MAX_LINE) {
  const all = String(output ?? "")
    .split("\n")
    .map((l) => l.replace(/\r/g, ""))
    .filter((l) => l.trim() !== "");
  const shown = all.slice(0, lines).map((l) => `  > ${clip(l, width)}`);
  if (all.length > lines) shown.push(`  > (+${all.length - lines} more lines)`);
  return shown;
}

/**
 * Lay out entries (a head line and the output of the command) inside a byte budget.
 * The head lines and the extra lines (the DIFF and NOTE lines) always stay. The excerpt length drops from `maxLines` to
 * 0 lines (and the line width from 130 to 80) until everything fits; if it still does not, the entries are cut, never the extras.
 * entry: { head: string, output?: string }
 */
export function layout(headers, entries, extras, budget, maxLines = 25) {
  const tail = extras.map((x) => clip(x, 260));
  const body = (lines, width) => [
    ...headers.map((h) => clip(h, 220)),
    ...entries.flatMap((e) => [
      clip(e.head, 200),
      ...excerpt(e.output, e.output ? lines : 0, width),
    ]),
  ];
  for (const [lines, width] of [
    [25, MAX_LINE],
    [15, MAX_LINE],
    [10, 110],
    [6, 100],
    [4, 90],
    [2, 80],
    [1, 80],
    [0, 80],
  ]) {
    const text = [...body(Math.min(lines, maxLines), width), ...tail].join("\n");
    if (bytes(text) <= budget) return text;
  }
  const room = Math.max(budget - bytes(tail.join("\n")) - 80, 200);
  const cut = body(0, 80).join("\n").slice(0, room);
  return [cut, "... (entries cut at the byte budget)", ...tail].join("\n");
}

/** The text again as `<TAG>|n|<line>` lines; a new chunk starts after about CHUNK_BYTES. */
export function chunk(tag, text) {
  const out = [];
  let n = 1;
  let used = 0;
  for (const line of text.split("\n")) {
    out.push(`${tag}|${n}|${line}`);
    used += bytes(line) + 1;
    if (used >= CHUNK_BYTES) {
      n += 1;
      used = 0;
    }
  }
  return out;
}

/** BEGIN, the text, the chunked copy, END. */
export function render(tag, text) {
  return [BEGIN, text, ...chunk(tag, text), END].join("\n");
}

export function emit(tag, text) {
  console.log(render(tag, text));
}

/** Worst exit status: 2 (tool error) over 1 (a documented command failed or differs) over 0. */
export const worst = (codes) => (codes.includes(2) ? 2 : codes.includes(1) ? 1 : 0);
