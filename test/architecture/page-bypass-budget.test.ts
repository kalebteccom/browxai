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
// Both measurements below are AST walks, because both were regexes and both were
// gameable:
//
//   - The budget counted the TEXT `requirePage(`. Hoisting one
//     `const page = requirePage(sess)` to the top of a module and reusing the
//     binding drops the count by as many sites as the module has, with nothing
//     architectural changed — `extensions-rebuild.ts` alone would have moved it by
//     17. What the budget claims to measure is how much code above the seam holds
//     a Playwright `Page`, so it counts USES of the handle: a bound result counts
//     once per reference, an unbound call counts once. Hoisting now moves it by
//     zero.
//   - The "only door" check matched receivers literally spelled `session` or
//     `sess`. `const s = e.session; s.page!()`, `e.session["page"]!()` and
//     `const { page } = e.session` all walked straight past it. It now looks for
//     the SHAPE — any call of a property named `page`, however the receiver is
//     spelled or subscripted, and any object-binding that destructures one.
//
// Each phase of RFC 0009 lowers BUDGET by what it moved; nothing may raise it. A
// new handler reaching for a `Page` fails here with a count, not a style opinion.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import depcruiseConfig from "../../.dependency-cruiser.cjs";

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
  {
    re: /^src\/session\/(launch-options|byob-attach)\.ts$/,
    why: "the Playwright session finalizers — they receive the launched handles and build the session object around them",
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

/** Page HANDLE USES outside `HANDLE_OWNERS`, as of RFC 0009 P1.
 *
 *  NOT comparable to the 102 this file pinned before: that was a count of the
 *  string `requirePage(`, and this is a count of what the handle is used FOR. A
 *  module that takes the handle once and reads eight things off it was one site
 *  under the old measure and is eight under this one, which is the point — eight
 *  reads are eight things a later phase has to move onto a port, and collapsing
 *  them into one binding moves none of them.
 *
 *  The clusters behind the number are RFC 0009's P2 through P5: `ElementSubstrate`
 *  (verify / locator / gesture geometry), the capture widenings (pdf / video /
 *  screenshot), `EventSubstrate` (replay, console, dialog), and the
 *  `extensions_*` context rebuild, which is one file and a sixth of the total.
 *
 *  P2 (`ElementSubstrate`) took it from 106 to 99: five in
 *  `read-observe-verify-tools.ts` (the whole `verify_*` family), one in
 *  `read-observe-dom-tools.ts` (`find`'s probe root) and one in
 *  `forms-plan-tools.ts` (`plan`, which held a `Page` only to hand it to `find`).
 *
 *  SEVEN, NOT THE RFC'S ~39. Those are two different measures and the RFC's table
 *  says so: its 39 counts `locator` / `getByRole` / `getByTestId` / `getByText`
 *  METHOD USES across non-test src, and 23 of those moved here. This budget counts
 *  `requirePage` handle uses, and most of the element cluster sits in `src/page`
 *  modules that take a `Page` as a parameter and never call `requirePage` at all —
 *  `gestures.ts` still needs one for `page.mouse`, which is P3's ActionSubstrate
 *  widening, not this phase's.
 *
 *  P3's capture widening took it from 99 to 97: one in
 *  `capture-report-export-tools.ts` (`pdf_save`, which held a `Page` only to hand
 *  it to `pdfSave`) and one in `session-registry.ts`'s teardown, which now takes
 *  the video flush from `CaptureSubstrate.prepareVideoSave`.
 *
 *  TWO, NOT THE RFC'S 16 + 11. Those count `page.pdf` / `page.video` METHOD uses
 *  across non-test src, and nearly all of them are inside `pdf.ts` and `video.ts`
 *  — the Playwright adapter bodies, which are below the seam and stay. The whole
 *  of the `video` cluster above the seam is the teardown save: `stop_video` and
 *  `get_video` never touch a `Page`, because Playwright's recorder is a
 *  context-creation primitive with no mid-session start or stop.
 *
 *  LOWER THIS, NEVER RAISE IT. A phase that moves N uses lands with the budget at
 *  `previous - N` in the same commit. */
const BUDGET = 97;

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

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/** The nearest function-like ancestor, or the file. The scope a `const page = …`
 *  binding is visible in, close enough that two same-named bindings in sibling
 *  functions are counted apart. */
function enclosingScope(node: ts.Node): ts.Node {
  let n: ts.Node | undefined = node.parent;
  while (
    n &&
    !ts.isFunctionDeclaration(n) &&
    !ts.isFunctionExpression(n) &&
    !ts.isArrowFunction(n) &&
    !ts.isMethodDeclaration(n) &&
    !ts.isConstructorDeclaration(n) &&
    !ts.isSourceFile(n)
  ) {
    n = n.parent;
  }
  return n ?? node;
}

function countReferences(scope: ts.Node, name: string, declaration: ts.Node): number {
  let hits = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== declaration) hits++;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return hits;
}

/** Strip the wrappers that sit between a call and the binding it initialises
 *  (`await`, `!`, parentheses, `as`), so a hoisted handle is still recognised as
 *  a binding rather than counted as a bare call. */
function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    n.parent &&
    (ts.isAwaitExpression(n.parent) ||
      ts.isNonNullExpression(n.parent) ||
      ts.isParenthesizedExpression(n.parent) ||
      ts.isAsExpression(n.parent))
  ) {
    n = n.parent;
  }
  return n;
}

/** How many times this file USES a Playwright `Page` obtained from the session.
 *  A `requirePage(...)` bound to a name counts once per reference to that name;
 *  an unbound call counts once. Hoisting a binding does not change the total. */
function pageHandleUses(sf: ts.SourceFile): number {
  let total = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "requirePage"
    ) {
      const outer = unwrap(node);
      const decl = outer.parent;
      if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
        total += Math.max(1, countReferences(enclosingScope(decl), decl.name.text, decl.name));
      } else {
        total += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return total;
}

/** Every syntactic way of reaching the session's `page` member that is not a call
 *  to `requirePage`. Calls of a property named `page` (`x.page()`, `x.page!()`,
 *  `x["page"]()`), and object-bindings that destructure one (`const { page } =
 *  …`). Receiver spelling is irrelevant — that was the hole. */
function sessionPageDoors(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee)) {
        callee = callee.expression;
      }
      const property = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : null;
      if (property === "page") hits.push(node.getText().split("\n")[0]!.slice(0, 80));
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const source = node.propertyName ?? node.name;
      if (ts.isIdentifier(source) && source.text === "page") {
        hits.push(node.parent.getText().split("\n")[0]!.slice(0, 80));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("L1 — the Playwright-Page bypass is counted and only shrinks", () => {
  const files = sourceFiles(SRC).map((f) => ({ path: rel(f), ast: parse(f) }));

  it("holds the Page-handle use count at or under the phase budget", () => {
    const counted = files
      .filter((f) => !isHandleOwner(f.path))
      .map((f) => ({ path: f.path, n: pageHandleUses(f.ast) }))
      .filter((f) => f.n > 0);
    const total = counted.reduce((sum, f) => sum + f.n, 0);
    const worst = [...counted].sort((a, b) => b.n - a.n).slice(0, 5);
    expect(
      total,
      `${total} Page-handle uses above the seam, budget ${BUDGET}. Heaviest: ` +
        `${worst.map((f) => `${f.path} (${f.n})`).join(", ")}. ` +
        "A new read of the session's target belongs on a capability substrate " +
        "(TargetSubstrate / CaptureSubstrate / …), not on requirePage. Hoisting the handle " +
        "into one binding does not lower this — it counts uses, not calls. If you MOVED " +
        "uses, lower BUDGET in the same commit.",
    ).toBeLessThanOrEqual(BUDGET);
  });

  it("counts a hoisted handle once per use, not once per module", () => {
    // The property that makes the budget a measurement rather than a formatting
    // preference. Both shapes below hold a `Page` three times; the old text count
    // scored them 3 and 1.
    const scattered = ts.createSourceFile(
      "scattered.ts",
      "function f(s: S) { requirePage(s).a(); requirePage(s).b(); requirePage(s).c(); }",
      ts.ScriptTarget.ESNext,
      true,
    );
    const hoisted = ts.createSourceFile(
      "hoisted.ts",
      "function f(s: S) { const page = requirePage(s); page.a(); page.b(); page.c(); }",
      ts.ScriptTarget.ESNext,
      true,
    );
    expect(pageHandleUses(scattered)).toBe(3);
    expect(pageHandleUses(hoisted)).toBe(3);
  });

  it("leaves `requirePage` as the only door to the optional page() member", () => {
    // The member is optional and deprecated; the chokepoint is what turns an
    // engine that backs no Page into a structured refusal instead of an opaque
    // `undefined is not a function`. A direct call re-opens that hole and, worse,
    // makes the count above meaningless.
    const offenders = files
      .filter((f) => !isHandleOwner(f.path))
      .map((f) => ({ path: f.path, hits: sessionPageDoors(f.ast) }))
      .filter((f) => f.hits.length > 0);
    expect(
      offenders.map((f) => `${f.path}: ${f.hits.join(" | ")}`),
      "call `requirePage(session)` (src/engine/session-page.ts) instead of reaching the " +
        "`page` member directly — any receiver spelling, any subscript, and destructuring " +
        "all land here",
    ).toEqual([]);
  });

  it("sees through receiver renaming, subscripting and destructuring", () => {
    // The four shapes the old regex missed. If this ever stops finding one of
    // them the door check has quietly reopened.
    const dodges = ts.createSourceFile(
      "dodges.ts",
      [
        "const s = e.session; s.page!();",
        'e.session["page"]!();',
        "const { page } = e.session;",
        "registry.get(id).session.page();",
      ].join("\n"),
      ts.ScriptTarget.ESNext,
      true,
    );
    expect(sessionPageDoors(dodges)).toHaveLength(4);
  });

  // The import-graph half of the same ratchet. `no-tools-or-replay-to-playwright-core`
  // forbids a Playwright TYPE in src/tools + src/replay; three modules are exempted
  // by name, each with the RFC 0009 phase that empties it. The rule is `error`, so
  // a fourth module fails the build — but the exception list itself is config, and
  // a fourth ENTRY would not. This pins it.
  //
  // It was five. P2 emptied `src/tools/target-resolve.ts` and
  // `src/tools/host-build.ts`, which named `Locator` only in `describeTarget`'s
  // signature; the caption measures through `ElementSubstrate` now. The three that
  // remain are all `src/replay`, and they leave with `EventSubstrate` in P4.
  it("keeps the Playwright-type exception list at or under three modules", () => {
    const rule = (
      depcruiseConfig as {
        forbidden: Array<{
          name: string;
          severity: string;
          from: { pathNot?: string[] };
        }>;
      }
    ).forbidden.find((r) => r.name === "no-tools-or-replay-to-playwright-core");
    expect(rule, "no-tools-or-replay-to-playwright-core is gone").toBeDefined();
    expect(rule!.severity, "a warn rule pins nothing — pnpm depcruise exits 0 on warnings").toBe(
      "error",
    );
    expect(
      rule!.from.pathNot ?? [],
      "the exception list only shrinks. Each entry is one module RFC 0009 has not reached " +
        "yet; a phase that empties one deletes it in the same commit, and adding one is an " +
        "RFC amendment with a written reason.",
    ).toHaveLength(3);
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
