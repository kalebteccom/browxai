// Bare-minimum TypeScript parse-check for the generated `.spec.ts`. We don't
// pull `typescript` in as a dependency for a single-file syntax pass — the
// lowered output is small, well-bounded, and we control every emitted line, so
// a structural sanity check is enough: matched braces / parens / quotes, the
// expected import line at the top, the expected test shell. Catches the "I
// emitted a line without closing the call" class of bug the cycle invariant
// calls out.
//
// Split out of `export-playwright-script.ts`: verifying the emitted source is a
// separate reason to change from producing it. Re-exported from that module so
// callers keep their existing import.

type Depth = { paren: number; brace: number; bracket: number };

/** Skip a comment or string token starting at `i`; returns the index just past
 *  it, or `i` unchanged when `i` doesn't start a comment/string. */
function skipCommentOrString(source: string, i: number): number {
  const c = source[i];
  if (c === "/" && source[i + 1] === "/") {
    const nl = source.indexOf("\n", i);
    return nl === -1 ? source.length : nl + 1;
  }
  if (c === "/" && source[i + 1] === "*") {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  return i;
}

const OPEN_DELIMS: Record<string, keyof Depth> = { "(": "paren", "{": "brace", "[": "bracket" };
const CLOSE_DELIMS: Record<string, keyof Depth> = { ")": "paren", "}": "brace", "]": "bracket" };

/** Apply one character's delimiter effect to `depth`. */
function applyDelimiter(c: string, depth: Depth): void {
  const open = OPEN_DELIMS[c];
  if (open) depth[open] += 1;
  const close = CLOSE_DELIMS[c];
  if (close) depth[close] -= 1;
}

export function parseCheck(source: string): { ok: true } | { ok: false; reason: string } {
  if (!source.startsWith('import { test, expect } from "@playwright/test";')) {
    return { ok: false, reason: "missing @playwright/test import header" };
  }
  if (!/\ntest\(/.test(source)) {
    return { ok: false, reason: "missing test(...) shell" };
  }
  // matched-delimiter pass — strings + comments are skipped so a `{` inside a
  // string literal isn't a false positive.
  let i = 0;
  const depth: Depth = { paren: 0, brace: 0, bracket: 0 };
  while (i < source.length) {
    const skipped = skipCommentOrString(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    applyDelimiter(source[i]!, depth);
    if (depth.paren < 0 || depth.brace < 0 || depth.bracket < 0) {
      return { ok: false, reason: `unbalanced delimiter at offset ${i}` };
    }
    i += 1;
  }
  if (depth.paren !== 0 || depth.brace !== 0 || depth.bracket !== 0) {
    return {
      ok: false,
      reason: `unbalanced delimiters at EOF (paren=${depth.paren}, brace=${depth.brace}, bracket=${depth.bracket})`,
    };
  }
  return { ok: true };
}
