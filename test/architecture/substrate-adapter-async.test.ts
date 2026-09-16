// L5 (substitutable adapters) — a substrate adapter method typed `Promise<T>`
// must be declared `async`. This is a BUG CLASS, not a style rule.
//
// Every Playwright adapter is built over an injected accessor, not over a stored
// handle: `new PlaywrightTargetSubstrate(() => requirePage(e.session), …)`. On an
// attached (BYOB) session that accessor is `boundPage`, which THROWS
// `attach-target-gone` the moment the user closes the tab. In a method declared
//
//     url(): Promise<string> { return Promise.resolve(this.page().url()); }
//
// the throw happens while evaluating the argument to `Promise.resolve` — before
// any promise exists. So it propagates SYNCHRONOUSLY, past the caller's
// `.catch(() => null)`, and the handler dies. The same body declared `async`
// turns the identical throw into a rejection the guard can see.
//
// The blast radius is why this is gated and not just fixed: `list_sessions`
// guards its per-session URL read with `.catch(() => null)` and lost EVERY
// healthy session in the registry to one dead tab; `point_probe` reads the URL
// inside its own catch block, so the second throw escaped the handler and took
// the structured `{ok:false, …}` envelope with it. Both guards were written
// correctly. The adapter made them unreachable.
//
// Three gates here, in order of reach:
//   1. the static scan — EVERY method on EVERY adapter file, so an adapter added
//      tomorrow is covered the day it lands;
//   2. the mechanism — the two spellings side by side, proving the static rule
//      has teeth and is not cargo cult;
//   3. the drive — the adapters the Playwright bundle builds over a `() => …`
//      accessor, each constructed with that accessor already throwing, with the
//      set of adapters derived from the bundle itself.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PlaywrightActionSubstrate } from "../../src/page/action-substrate.js";
import { PlaywrightCaptureSubstrate } from "../../src/page/capture-substrate.js";
import { PlaywrightStorageSubstrate } from "../../src/page/storage-substrate.js";
import { PlaywrightScriptSubstrate } from "../../src/page/script-substrate.js";
import { PlaywrightEmulationSubstrate } from "../../src/page/emulation-substrate.js";
import { PlaywrightTargetSubstrate } from "../../src/page/target-substrate.js";

const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src/page");

/** The adapter implementations: one file per engine family behind a port. The
 *  `-types.ts` ports and the `-select.ts` selectors are not adapters. */
const ADAPTER_FILE = /-substrate-(playwright|safari|cdp)\.ts$/;

interface PromiseMethod {
  cls: string;
  name: string;
  isAsync: boolean;
  line: number;
}

/** Every method WITH A BODY whose declared return type is `Promise<…>`, tagged
 *  with whether it is `async`. Interface members have no body and are skipped —
 *  a port cannot be `async`, only its implementations can. */
function promiseMethods(file: string): PromiseMethod[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const found: PromiseMethod[] = [];
  const visit = (node: ts.Node, cls: string): void => {
    const nextCls = ts.isClassDeclaration(node) && node.name ? node.name.text : cls;
    if (
      ts.isMethodDeclaration(node) &&
      node.body &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      node.type.typeName.getText(sf) === "Promise"
    ) {
      found.push({
        cls: nextCls,
        name: node.name.getText(sf),
        isAsync: (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(node, (child) => visit(child, nextCls));
  };
  ts.forEachChild(sf, (n) => visit(n, "<module>"));
  return found;
}

const ADAPTER_FILES = readdirSync(PAGE_DIR)
  .filter((f) => ADAPTER_FILE.test(f))
  .sort();

/** Method names per adapter class, from the same scan the static gate uses — so
 *  the drive below covers a method the day it is added, with no second list. */
const METHODS_BY_CLASS = new Map<string, string[]>();
for (const f of ADAPTER_FILES) {
  for (const m of promiseMethods(join(PAGE_DIR, f))) {
    METHODS_BY_CLASS.set(m.cls, [...(METHODS_BY_CLASS.get(m.cls) ?? []), m.name]);
  }
}

describe("L5 — every substrate adapter method typed Promise<T> is async", () => {
  it("scans the adapter files (the glob has not gone stale)", () => {
    // A rename that stopped matching `ADAPTER_FILE` would silently empty this
    // suite; the floor is the count at RFC 0009 P1 and it only grows.
    expect(ADAPTER_FILES.length).toBeGreaterThanOrEqual(18);
    expect(METHODS_BY_CLASS.size).toBeGreaterThanOrEqual(18);
  });

  it.each(ADAPTER_FILES)("[%s] declares every Promise-returning method async", (file) => {
    const sync = promiseMethods(join(PAGE_DIR, file))
      .filter((m) => !m.isAsync)
      .map((m) => `${m.cls}.${m.name}() at ${file}:${m.line}`);
    expect(
      sync,
      "A method typed `Promise<T>` that is not `async` throws SYNCHRONOUSLY when its " +
        "injected accessor throws — past every caller's `.catch()`. Declare it `async`.",
    ).toEqual([]);
  });
});

describe("the mechanism — why the `async` keyword is load-bearing", () => {
  const boom = (): string => {
    throw new Error("attach-target-gone");
  };

  it("a non-async Promise<T> method escapes the caller's .catch()", () => {
    class NotAsync {
      url(): Promise<string> {
        return Promise.resolve(boom());
      }
    }
    // The `.catch` is attached to a promise that never gets created.
    expect(() => new NotAsync().url().catch(() => null)).toThrow("attach-target-gone");
  });

  it("the same body declared async rejects, so the .catch() runs", async () => {
    class IsAsync {
      async url(): Promise<string> {
        return boom();
      }
    }
    await expect(new IsAsync().url().catch(() => null)).resolves.toBeNull();
  });
});

const GONE = "attach-target-gone: the attached tab is closed";

/** The injected accessor of a session whose target is gone — `boundPage`'s
 *  behaviour once `target.page.isClosed()`. */
const gone = (): never => {
  throw new Error(GONE);
};

/** Adapters the Playwright `SubstrateBundle` builds over a `() => …` accessor.
 *  These are the ones carrying the live hazard: the accessor is re-evaluated per
 *  call, so it can start throwing long after construction. */
const DRIVEN: ReadonlyArray<{ cls: string; make: () => object }> = [
  { cls: "PlaywrightActionSubstrate", make: () => new PlaywrightActionSubstrate(gone) },
  {
    cls: "PlaywrightCaptureSubstrate",
    make: () => new PlaywrightCaptureSubstrate(gone, {} as never, {} as never),
  },
  { cls: "PlaywrightStorageSubstrate", make: () => new PlaywrightStorageSubstrate(gone, gone) },
  { cls: "PlaywrightScriptSubstrate", make: () => new PlaywrightScriptSubstrate(gone) },
  {
    cls: "PlaywrightEmulationSubstrate",
    make: () => new PlaywrightEmulationSubstrate(gone, gone),
  },
  { cls: "PlaywrightTargetSubstrate", make: () => new PlaywrightTargetSubstrate(gone) },
];

/** The classes `substrate-bundle.ts` instantiates with a zero-parameter arrow
 *  argument, read off the bundle's own AST. Derived, so a new thunk-injected
 *  adapter forces an entry in `DRIVEN` instead of slipping in uncovered. */
function thunkInjectedInBundle(): string[] {
  const file = join(PAGE_DIR, "substrate-bundle.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.arguments ?? []).some((a) => ts.isArrowFunction(a) && a.parameters.length === 0)
    ) {
      names.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return [...names].sort();
}

describe("a gone accessor rejects, never throws synchronously", () => {
  it("drives every thunk-injected adapter the Playwright bundle builds", () => {
    expect(DRIVEN.map((d) => d.cls).sort()).toEqual(thunkInjectedInBundle());
  });

  it.each(DRIVEN.map((d) => [d.cls, d] as const))("[%s] every port method", async (cls, entry) => {
    const sub = entry.make() as Record<string, (...a: unknown[]) => unknown>;
    const methods = METHODS_BY_CLASS.get(cls);
    expect(methods, `no Promise-returning methods scanned for ${cls}`).toBeTruthy();
    let reachedAccessor = 0;
    for (const name of methods!) {
      // The call itself must not throw — that is the whole contract. Args are
      // placeholders; the adapter reaches its accessor before it needs them.
      let promise: unknown;
      expect(() => {
        promise = sub[name]({}, {}, {});
      }, `${cls}.${name}() threw synchronously`).not.toThrow();
      expect(promise, `${cls}.${name}() did not return a promise`).toBeInstanceOf(Promise);
      const err = await (promise as Promise<unknown>).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, `${cls}.${name}() resolved on a gone target`).toBeInstanceOf(Error);
      if ((err as Error).message.includes(GONE)) reachedAccessor += 1;
    }
    // At least one method actually reached the dead accessor, so the suite is
    // exercising the real failure and not an arity mismatch.
    expect(reachedAccessor, `no ${cls} method reached the gone accessor`).toBeGreaterThan(0);
  });
});
