// L1 / L5 — every capability port is where the port rule can see it.
//
// `ports-name-no-vendor-type` (.dependency-cruiser.cjs) is the machine that stops
// a port naming a Playwright type. It selects the modules it guards by PATH, so
// its guarantee is only as wide as that pattern: a port interface declared
// somewhere the pattern misses is unguarded, and nothing else would notice.
//
// This test closes the selector. It parses the tree, finds every exported
// interface whose name ends in `Substrate` — the repo's word for a capability
// port — and asserts each one is declared in a file the rule's own `from.path`
// matches. The pattern is READ OUT OF THE CONFIG, not restated here, so the two
// cannot drift: tighten or loosen the rule and this test follows.
//
// The parse is an AST walk, not a regex over source text. `export interface
// FooSubstrate` inside a comment or a template literal is not a declaration, and
// a regex cannot tell the difference.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import depcruiseConfig from "../../.dependency-cruiser.cjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(ROOT, "src");

interface ForbiddenRule {
  name: string;
  severity: string;
  from: { path?: string };
  to: { path?: string; reachable?: boolean };
}

const PORT_RULE = (depcruiseConfig as { forbidden: ForbiddenRule[] }).forbidden.find(
  (r) => r.name === "ports-name-no-vendor-type",
);

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

/** Every exported `interface *Substrate` in a file, by AST. */
function portInterfacesIn(file: string): string[] {
  const src = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  for (const stmt of src.statements) {
    if (!ts.isInterfaceDeclaration(stmt)) continue;
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) continue;
    if (stmt.name.text.endsWith("Substrate")) found.push(stmt.name.text);
  }
  return found;
}

describe("L1 — every capability port sits where the port rule guards it", () => {
  const ports = sourceFiles(SRC).flatMap((file) =>
    portInterfacesIn(file).map((name) => ({ name, path: rel(file) })),
  );

  it("the port rule exists, is reachable-scoped, and fails the build", () => {
    // The three properties the rule needs to mean its own comment. A direct-edge
    // version of this rule passed while six of the eight ports reached
    // playwright-core one hop away, and a `warn` version pins nothing.
    expect(
      PORT_RULE,
      "ports-name-no-vendor-type is gone from .dependency-cruiser.cjs",
    ).toBeDefined();
    expect(PORT_RULE!.severity).toBe("error");
    expect(PORT_RULE!.to.reachable, "a direct-edge rule states less than this rule's comment").toBe(
      true,
    );
    expect(PORT_RULE!.to.path).toMatch(/playwright-core/);
  });

  it("finds the ports at all (the AST walk is not silently empty)", () => {
    // A selector bug that matched nothing would make every assertion below pass
    // vacuously. Seven capability ports ship today (action / capture / emulation
    // / network / script / snapshot / storage) plus TargetSubstrate from P1.
    expect(ports.length).toBeGreaterThanOrEqual(8);
  });

  it("declares every *Substrate port in a module the rule's from.path matches", () => {
    const guarded = new RegExp(PORT_RULE!.from.path!);
    const unguarded = ports.filter((p) => !guarded.test(p.path));
    expect(
      unguarded.map((p) => `${p.name} in ${p.path}`),
      `a capability port outside ${guarded} is not covered by ports-name-no-vendor-type — ` +
        "it could name a Playwright type and the build would stay green. Move the interface " +
        "into a `<name>-substrate-types.ts` leaf beside its adapters, or widen the rule's " +
        "from.path in the same commit.",
    ).toEqual([]);
  });

  it("keeps the port declaration out of the barrel that re-exports its adapters", () => {
    // The `*-substrate.ts` barrels are deliberately outside the rule: they
    // re-export the `Playwright*Substrate` class at runtime, so they reach
    // playwright-core by construction. That is only safe while no port interface
    // is DECLARED in one.
    const inBarrel = ports.filter((p) => /-substrate\.ts$/.test(p.path));
    expect(
      inBarrel.map((p) => `${p.name} in ${p.path}`),
      "a port declared in a substrate barrel is unguarded — the barrel imports its own " +
        "Playwright adapter, so the rule cannot hold there. Declare it in the -types leaf.",
    ).toEqual([]);
  });
});
