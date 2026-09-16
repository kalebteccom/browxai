// L1 (the closed core) — the Playwright-`Page` bypass is counted, and the count
// only goes down.
//
// `BrowserSession.page()` was a mandatory member that handed any handler a
// Playwright `Page`, so a handler could skip the capability port entirely. RFC
// 0009 P1 made the member optional and routed every caller through one
// chokepoint, `requirePage(session)`. That is what makes the bypass MEASURABLE:
// before the chokepoint the sites were `e.session.page()`, `sess.page()`,
// `s.page()` and four multi-line chain forms, obtained by inference with the
// `Page` type imported zero times — a shape no import-graph rule can see and no
// single grep catches.
//
// This test is the ratchet. Each phase of RFC 0009 lowers BUDGET by what it
// moved; nothing may raise it. A new handler reaching for a `Page` fails here
// with a count, not a style opinion.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");

/** Modules where holding a Playwright `Page` is the job, not a bypass. This is
 *  the `PLAYWRIGHT_HANDLE_ALLOWLIST` of RFC 0009 §Enforcement, and it shrinks by
 *  phase exactly as the budget does. Each entry carries why it is here. */
const HANDLE_OWNERS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /^src\/engine\/adapters\//, why: "the adapters launch and own the browser" },
  { re: /^src\/engine\/session-page\.ts$/, why: "the chokepoint itself" },
  {
    re: /^src\/session\/playwright-(handle|post-wire)\.ts$/,
    why: "the Playwright engine's own post-creation wiring",
  },
  { re: /^src\/page\/[a-z-]+-playwright\.ts$/, why: "the Playwright substrate adapters" },
  {
    re: /^src\/page\/substrate-bundle\.ts$/,
    why: "the Playwright engine's substrate factory — where a Page is handed to an adapter",
  },
  {
    re: /^src\/page\/[a-z-]+-substrate-select\.ts$/,
    why: "substrate selection, the one place that picks an adapter for a session",
  },
];

/** The bypass count outside `HANDLE_OWNERS`, as of RFC 0009 P1.
 *
 *  It was 114 at this branch's base. P1 moved 12: ten URL reads and one title
 *  read onto `TargetSubstrate`, and one Safari branch that collapsed with them.
 *  The remaining 102 are the clusters RFC 0009 assigns to P2 through P5 —
 *  `ElementSubstrate` (verify / locator / gesture geometry), the capture
 *  widenings (pdf / video / screenshot), `EventSubstrate` (replay, console,
 *  dialog), and the `extensions_*` context rebuild at 17 sites in one file.
 *
 *  LOWER THIS, NEVER RAISE IT. A phase that moves N sites lands with the budget
 *  at `previous - N` in the same commit. */
const BUDGET = 102;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

/** Repo-relative, forward-slashed, so the patterns read the same on any OS. */
function rel(file: string): string {
  return `src/${relative(SRC, file).split(sep).join("/")}`;
}

function isHandleOwner(path: string): boolean {
  return HANDLE_OWNERS.some((o) => o.re.test(path));
}

describe("L1 — the Playwright-Page bypass is counted and only shrinks", () => {
  const files = sourceFiles(SRC).map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }));

  it("holds the bypass count at or under the phase budget", () => {
    const counted = files
      .filter((f) => !isHandleOwner(f.path))
      .map((f) => ({ path: f.path, n: (f.text.match(/\brequirePage\(/g) ?? []).length }))
      .filter((f) => f.n > 0);
    const total = counted.reduce((sum, f) => sum + f.n, 0);
    const worst = [...counted].sort((a, b) => b.n - a.n).slice(0, 5);
    expect(
      total,
      `${total} Page-bypass sites, budget ${BUDGET}. Heaviest: ` +
        `${worst.map((f) => `${f.path} (${f.n})`).join(", ")}. ` +
        "A new read of the session's target belongs on a capability substrate " +
        "(TargetSubstrate / CaptureSubstrate / …), not on requirePage. If you MOVED sites, " +
        "lower BUDGET in the same commit.",
    ).toBeLessThanOrEqual(BUDGET);
  });

  it("leaves `requirePage` as the only door to the optional page() member", () => {
    // The member is optional and deprecated; the chokepoint is what turns an
    // engine that backs no Page into a structured refusal instead of an opaque
    // `undefined is not a function`. A direct call re-opens that hole and, worse,
    // makes the count above meaningless.
    const offenders = files
      .filter((f) => f.path !== "src/engine/session-page.ts")
      .map((f) => ({
        path: f.path,
        hits: f.text
          .replace(/\/\/[^\n]*/g, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .match(/(?<![\w.])(?:\w+\.)*(?:session|sess)\s*\.page\??\(\)/g),
      }))
      .filter((f) => f.hits);
    expect(
      offenders.map((f) => `${f.path}: ${f.hits!.join(", ")}`),
      "call `requirePage(session)` (src/engine/session-page.ts) instead of `session.page()`",
    ).toEqual([]);
  });

  it("names a reason for every module allowed to hold a Page", () => {
    // An allowlist without per-entry rationale is a list of exceptions nobody can
    // audit. Entries come off as phases empty them; one going on is an RFC
    // amendment with a written reason.
    for (const owner of HANDLE_OWNERS) {
      expect(owner.why.length, `${owner.re} has no rationale`).toBeGreaterThan(20);
    }
  });
});
