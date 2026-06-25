// L8 (assert the invariants) — the assertion-density enforcer. RFC 0004 P5 / 02
// §4.1. Power-of-Ten rule 5 is "≥ 2 assertions per FUNCTION" — a flight-software
// density chosen for a domain where every function is on a safety path. browxai
// scopes the density to where it pays: the LOAD-BEARING modules (the capability
// gate / host, the engine registry, the session-window orchestrator, the network
// ring, the config precedence chain, the perf-audit bound). An invariant on a
// leaf page helper is noise; an invariant on "the engine registry resolves each
// kind to exactly one entry" is load-bearing (02 §4.1).
//
// The threshold is a FLOOR the modules satisfy after the P5 invariant pass — not
// an unreachable tree-wide "≥ 2 per function" (which would flag good leaf code and
// get disabled, the anti-pattern 02 §3 L3(f) warns against). The floor is: each
// load-bearing module carries at least `MIN_INVARIANTS_PER_MODULE` `invariant(…)`
// call-site, asserted from the real AST so it tracks the live calls, not a
// hand-copied count. A module that loses its invariants (a refactor that drops
// the contract) fails here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The declared load-bearing module list (02 §4.1 / 0004-04 P5). The density
 *  floor applies HERE, scoped — never blanket tree-wide. */
const LOAD_BEARING_MODULES = [
  "src/page/actionresult.ts",
  // network.ts is now a barrel; the load-bearing CDP runtime (the NetworkBuffer
  // ring + its cap invariants) lives in network-cdp.ts after the domain/adapter
  // split, so the L8 floor follows the logic to its new home.
  "src/page/network-cdp.ts",
  "src/tools/host-build.ts",
  "src/engine/registry.ts",
  "src/util/config-store.ts",
  // perf-audit.ts is now the composer/scorer; the token-budget termination
  // contracts (the L7 enforcement invariants) moved to perf-audit-budget.ts.
  "src/page/perf-audit-budget.ts",
] as const;

/** The floor: every load-bearing module carries at least this many `invariant()`
 *  calls after the P5 pass. 1 is the calibrated floor — each module today has 1–3
 *  (sized from what the current contracts already imply, not an aspirational
 *  blanket), so the tree is green and a module that drops its last invariant
 *  fails. Ratchets up only as more contracts are asserted; never relaxed without
 *  an RFC amendment (the meta-rule). */
const MIN_INVARIANTS_PER_MODULE = 1;

/** Count `invariant(...)` CALL expressions (not the import or the helper
 *  definition) in a source file, walking the real TypeScript AST so the count
 *  tracks the live calls. */
function countInvariantCalls(relPath: string): number {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "invariant"
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return count;
}

describe("L8 — load-bearing modules carry the asserted invariants", () => {
  it("every load-bearing module is at or above the invariant-density floor", () => {
    for (const mod of LOAD_BEARING_MODULES) {
      const n = countInvariantCalls(mod);
      expect(
        n,
        `${mod} has ${n} invariant() call(s) — below the ${MIN_INVARIANTS_PER_MODULE}-per-module ` +
          `floor (L8). Assert the internal contracts this module already depends on (no-ops on ` +
          `valid inputs) via invariant() from src/util/invariant.js. Do NOT relax the floor to ` +
          `pass — that is an RFC amendment, not a feature edit.`,
      ).toBeGreaterThanOrEqual(MIN_INVARIANTS_PER_MODULE);
    }
  });

  it("the invariant helper itself exists and exports invariant + InvariantError", () => {
    const src = readFileSync(join(ROOT, "src/util/invariant.ts"), "utf8");
    expect(src).toMatch(/export function invariant\(/);
    expect(src).toMatch(/export class InvariantError/);
    // The L8 posture: a STRUCTURED, contained error (the DeadlineError idiom), not
    // a bare assert — InvariantError extends Error and is thrown, so the dispatch
    // boundary renders it as a ToolResponse refusal, never a process crash.
    expect(src).toMatch(/asserts cond/); // TS assertion signature (also narrows, L6 inward)
  });

  it("every load-bearing module imports invariant from the shared helper (one idiom)", () => {
    for (const mod of LOAD_BEARING_MODULES) {
      const src = readFileSync(join(ROOT, mod), "utf8");
      expect(
        src,
        `${mod} must import invariant from the shared util/invariant helper (one assertion idiom ` +
          `in the tree, never a bespoke throw).`,
      ).toMatch(/import \{ invariant \} from ["'][^"']*invariant\.js["']/);
    }
  });
});
