// L1 / D6 (OCP) — no EXTENSIBILITY switch. RFC 0004 P4 replaced every
// dispatch-over-a-string-key switch at a PROVEN OCP extension point with an
// add-only registry: the CLI subcommand switch (cli.ts), the plugin-CLI
// subcommand switch (plugin/cli.ts), the SDK transport switch (sdk/index.ts),
// the perf-analyser record (page/perf-audit*.ts), and the config-layer
// precedence (util/config-store.ts). This fitness test freezes that win: a NEW
// `switch` whose arms each DISPATCH to a distinct handler/factory over a string
// key — the shape a new case would extend — must not REGROW at any of those
// seams (nor inside the registries that replaced them). A new command /
// transport / analyser / config-layer is a registration, not a new `case`.
//
// SCOPED PRECISELY (the RFC's instruction). Two scoping axes keep this from
// flagging legitimate switches:
//
//   1. WHERE — only the extension-point files P4 closed (EXTENSION_POINT below)
//      plus the registry files. This is deliberately NOT a whole-tree scan: a
//      dispatch switch over a CLOSED, fixed vocabulary internal to one algorithm
//      (e.g. `switch (typeof v)`, `switch (schema.type)` JSON-schema resolution,
//      `switch (d.verb)` plan lowering, `switch (name)` credential providers) is
//      not an add-only-registry candidate — those vocabularies are fixed by a
//      spec/language, not extended by third parties. The proven-seam test
//      (architecture-principles §1) gates which seams become registries; this
//      test guards exactly those, no more.
//   2. WHAT — only the *dispatch* shape: ≥2 arms that each select a DISTINCT
//      callee/constructor for the SAME operation (the `x = openFooTransport()` /
//      `case "foo": return runFoo()` shape). It does NOT flag value-mapping
//      arms (return a literal/property) or state-machine arms (mutate shared
//      state), nor the residual literal fast-paths a registry-backed dispatcher
//      keeps (cli.ts's `--version`/`--help` arms return/exit with no dispatch).
//
// Detection is static (the TypeScript AST), so it tracks the live source — no
// hand-copied list of "bad" switches that could itself drift.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../src");

/** The files that own the OCP extension points P4 closed — the dispatchers that
 *  now resolve through a registry, and the registries themselves. None may
 *  contain a dispatch switch: the dispatch lives in the `Map.get(...)` resolve,
 *  not a `case`. A new extension point added in a future phase appends its file
 *  here (the same way it appends a registry). */
const GUARDED_FILES = [
  // The dispatchers P4 converted to registry lookups.
  "cli.ts",
  "plugin/cli.ts",
  "sdk/index.ts",
  // The perf-analyser registry + its derived union/array.
  "page/perf-audit.ts",
  "page/perf-audit-analysers.ts",
  // The data-driven config-layer precedence.
  "util/config-store.ts",
  // The registries themselves — the sanctioned dispatch is `Map.get`, never a
  // switch; if one regrows a switch, that is the same debt by another name.
  "cli/command-registry.ts",
  "plugin/command-registry.ts",
  "sdk/transport-registry.ts",
  "plugin/package-manager.ts",
] as const;

/** Resolve the guarded files to absolute paths, asserting each exists (so a
 *  rename can't silently drop a file out of the guard). */
function guardedFiles(): string[] {
  return GUARDED_FILES.map((rel) => join(SRC_ROOT, rel));
}

/** Is this case-clause body a DISPATCH arm — its primary effect a call to a
 *  named function/method or a `new` construction (the thing a registry value
 *  would hold)? Returns the dispatched callee name, or null for value-return /
 *  state-mutation arms (which are NOT extensibility dispatch). */
function dispatchCalleeOf(clause: ts.CaseOrDefaultClause): string | null {
  for (const stmt of clause.statements) {
    // Unwrap the common dispatch shapes:
    //   x = await openFoo(...)        (assignment from a call)
    //   return runFoo(...)            (return of a call)
    //   process.exit(await runFoo())  (call wrapping a call)
    //   transport = new FooTransport()
    let expr: ts.Expression | undefined;
    if (ts.isExpressionStatement(stmt)) expr = stmt.expression;
    else if (ts.isReturnStatement(stmt)) expr = stmt.expression;
    if (!expr) continue;
    const callee = innerDispatchCallee(expr);
    if (callee) return callee;
  }
  return null;
}

/** Drill through `=`, `await`, and wrapping calls to find a distinct factory/
 *  handler callee. Returns its name, or null when the expression is a literal /
 *  property read / state mutation (no dispatch). */
function innerDispatchCallee(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  // x = <rhs>  → inspect rhs
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    e = e.right;
  }
  // await <inner>  → inspect inner
  if (ts.isAwaitExpression(e)) e = e.expression;
  if (ts.isCallExpression(e)) {
    // process.exit(await runFoo())  → the meaningful callee is the inner call,
    // when present; otherwise the call itself (e.g. `runFoo()` / `cmdFoo()`).
    for (const arg of e.arguments) {
      const inner = innerDispatchCallee(arg);
      if (inner) return inner;
    }
    return calleeName(e.expression);
  }
  if (ts.isNewExpression(e)) return calleeName(e.expression);
  return null;
}

/** A name for a call/new target, when it is a plain or member identifier. */
function calleeName(target: ts.Expression): string | null {
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly discriminant: string;
  readonly callees: readonly string[];
}

/** Find dispatch-shaped switches in one source file. A switch is "dispatch" when
 *  ≥2 non-default case arms each dispatch to a DISTINCT callee (≥2 distinct
 *  callees total) — i.e. the arms are parallel implementations selected by the
 *  discriminant, which is exactly the OCP extension point a registry replaces. */
function dispatchSwitches(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node)) {
      const dispatchCallees: string[] = [];
      for (const clause of node.caseBlock.clauses) {
        const callee = dispatchCalleeOf(clause);
        if (callee) dispatchCallees.push(callee);
      }
      const distinct = new Set(dispatchCallees);
      // ≥2 arms dispatching, ≥2 DISTINCT callees → parallel-implementation
      // dispatch (a registry's job), not a value-map/state-machine.
      if (dispatchCallees.length >= 2 && distinct.size >= 2) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({
          file,
          line: line + 1,
          discriminant: node.expression.getText(sf),
          callees: [...distinct],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

describe("D6 / L1 — no extensibility switch (dispatch over a string key)", () => {
  const files = guardedFiles();

  it("every guarded extension-point file exists (the guard can't silently lapse)", () => {
    for (const [i, abs] of files.entries()) {
      expect(existsSync(abs), `${GUARDED_FILES[i]} must exist under src/`).toBe(true);
    }
  });

  it("no dispatch-shaped switch survives at the OCP extension points P4 closed", () => {
    const violations: Finding[] = [];
    for (const [i, abs] of files.entries()) {
      if (!existsSync(abs)) continue;
      const source = readFileSync(abs, "utf8");
      for (const f of dispatchSwitches(abs, source)) {
        violations.push({ ...f, file: GUARDED_FILES[i] });
      }
    }
    const message =
      violations.length === 0
        ? ""
        : "Extensibility dispatch switch(es) found — convert to an add-only registry " +
          "(RFC 0004 D6, pattern 7):\n" +
          violations
            .map(
              (v) =>
                `  ${v.file}:${v.line} — switch (${v.discriminant}) dispatches to {${v.callees.join(", ")}}. ` +
                `Register these handlers in a Map and resolve by key instead.`,
            )
            .join("\n");
    expect(violations, message).toHaveLength(0);
  });
});
