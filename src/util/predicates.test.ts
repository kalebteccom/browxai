import { describe, it, expect } from "vitest";
import {
  evaluatePredicate,
  validatePredicate,
  resolveKey,
  isAllowedKey,
  type Predicate,
} from "./predicates.js";

// Sample data bag mirroring what `verify_predicate` callers stage.
const SAMPLE = {
  actionResult: {
    ok: true,
    element: { value: "hello world", displayText: "Engineering" },
    navigation: { changed: true, kind: "spa", to: "https://example.com/x" },
    console: { errors: ["one"], warnings: 0 },
    structure: { appeared: [{ ref: "e1" }], removed: [], newTabs: [] },
    network: { summary: { total: 7 } },
  },
  snapshot: {
    warnings: ["pre", "post"],
  },
};

describe("isAllowedKey + allowedKeyRoots", () => {
  it("rejects unknown roots (no arbitrary-prefix drill)", () => {
    expect(isAllowedKey("page.url")).toBe(false);
    expect(isAllowedKey("__proto__.toString")).toBe(false);
    expect(isAllowedKey("")).toBe(false);
  });
});

describe("resolveKey", () => {
  // The root passes (`actionResult` is allow-listed); the denylist must still
  // trip on `__proto__` / `constructor` / `prototype` MID-walk so the engine
  // can never return a function/prototype object.
  it.each([
    ["nested value via dotted access", "actionResult.element.value", "hello world"],
    ["length over an array", "actionResult.console.errors.length", 1],
    ["length over a string", "actionResult.element.value.length", "hello world".length],
    [
      "missing intermediates resolve undefined without throwing",
      "actionResult.missing.path",
      undefined,
    ],
    ["__proto__ segment is refused", "actionResult.__proto__", undefined],
    ["constructor segment is refused", "actionResult.constructor", undefined],
    ["prototype segment is refused", "actionResult.element.prototype", undefined],
  ])("resolveKey: %s", (_label, key, expected) => {
    expect(resolveKey(SAMPLE, key)).toBe(expected);
  });
});

describe("evaluatePredicate — leaf kinds", () => {
  const total = "actionResult.network.summary.total";
  const value = "actionResult.element.value";
  const to = "actionResult.navigation.to";
  const errors = "actionResult.console.errors";

  it.each<[string, Predicate, boolean]>([
    [
      "equals matches a strict-equal scalar",
      { kind: "equals", key: value, value: "hello world" },
      true,
    ],
    ["equals fails on a different scalar", { kind: "equals", key: value, value: "nope" }, false],
    ["notEquals passes on a different value", { kind: "notEquals", key: value, value: "no" }, true],
    [
      "notEquals fails on an equal value",
      { kind: "notEquals", key: value, value: "hello world" },
      false,
    ],
    ["contains finds a substring", { kind: "contains", key: value, value: "world" }, true],
    ["contains finds an array member", { kind: "contains", key: errors, value: "one" }, true],
    [
      "contains misses an absent array member",
      { kind: "contains", key: errors, value: "absent" },
      false,
    ],
    ["gt is numeric", { kind: "gt", key: total, value: 5 }, true],
    ["lt is numeric", { kind: "lt", key: total, value: 10 }, true],
    ["gte is inclusive", { kind: "gte", key: total, value: 7 }, true],
    ["lte is inclusive", { kind: "lte", key: total, value: 7 }, true],
    ["gt rejects a non-number", { kind: "gt", key: value, value: 3 }, false],
    ["between is inclusive numeric (inside)", { kind: "between", key: total, lo: 0, hi: 10 }, true],
    [
      "between is inclusive numeric (outside)",
      { kind: "between", key: total, lo: 8, hi: 10 },
      false,
    ],
    [
      "matches takes a regex string (hit)",
      { kind: "matches", key: to, value: "^https://example\\.com" },
      true,
    ],
    ["matches takes a regex string (miss)", { kind: "matches", key: to, value: "nope" }, false],
    ["exists passes on a present value", { kind: "exists", key: value }, true],
    ["exists fails on a missing value", { kind: "exists", key: "actionResult.missing" }, false],
  ])("%s", (_label, pred, ok) => {
    expect(evaluatePredicate(pred, SAMPLE).ok).toBe(ok);
  });

  it("failures carry kind/actual/expected, and a key root outside the allow-list fails loudly", () => {
    const fail = evaluatePredicate(
      { kind: "equals", key: "actionResult.element.value", value: "nope" },
      SAMPLE,
    );
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.kind).toBe("equals");
      expect(fail.actual).toBe("hello world");
      expect(fail.expected).toContain("equals");
    }
    const outside = evaluatePredicate({ kind: "equals", key: "foo.bar", value: "x" }, SAMPLE);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.expected).toContain("allow-list");
  });
});

describe("evaluatePredicate — and / or / not", () => {
  const kind = "actionResult.navigation.kind";
  const hello = { kind: "contains", key: "actionResult.element.value", value: "hello" } as const;

  it.each<[string, Predicate, boolean, (r: ReturnType<typeof evaluatePredicate>) => void]>([
    [
      "and: all children pass",
      { kind: "and", predicates: [hello, { kind: "equals", key: kind, value: "spa" }] },
      true,
      () => undefined,
    ],
    [
      "and: one failing child fails with the child index",
      { kind: "and", predicates: [hello, { kind: "equals", key: kind, value: "wrong" }] },
      false,
      (r) => {
        if (r.ok) throw new Error("expected failure");
        expect(r.kind).toBe("and");
        expect(r.expected).toContain("and(child[1]");
      },
    ],
    [
      "or: short-circuits on the first passing child",
      {
        kind: "or",
        predicates: [
          { kind: "equals", key: kind, value: "full_load" },
          { kind: "equals", key: kind, value: "spa" },
        ],
      },
      true,
      () => undefined,
    ],
    [
      "or: fails with structured per-child actuals when none hold",
      {
        kind: "or",
        predicates: [
          { kind: "equals", key: kind, value: "a" },
          { kind: "equals", key: kind, value: "b" },
        ],
      },
      false,
      (r) => {
        if (r.ok) throw new Error("expected failure");
        expect(r.kind).toBe("or");
        expect(Array.isArray(r.actual)).toBe(true);
      },
    ],
    [
      "not: passes when the child fails",
      { kind: "not", predicates: [{ kind: "equals", key: kind, value: "full_load" }] },
      true,
      () => undefined,
    ],
    [
      "not: fails when the child passes",
      { kind: "not", predicates: [{ kind: "equals", key: kind, value: "spa" }] },
      false,
      () => undefined,
    ],
  ])("%s", (_label, pred, ok, detail) => {
    const r = evaluatePredicate(pred, SAMPLE);
    expect(r.ok).toBe(ok);
    detail(r);
  });
});

describe("validatePredicate", () => {
  it("accepts well-formed leaves and composites", () => {
    expect(validatePredicate({ kind: "equals", key: "actionResult.x", value: 1 })).toBeNull();
    expect(
      validatePredicate({ kind: "between", key: "snapshot.warnings.length", lo: 0, hi: 5 }),
    ).toBeNull();
    expect(validatePredicate({ kind: "exists", key: "actionResult.element" })).toBeNull();
    expect(
      validatePredicate({
        kind: "and",
        predicates: [{ kind: "equals", key: "actionResult.x", value: 1 }],
      }),
    ).toBeNull();
  });

  it("rejects unknown kinds, missing fields, and bad accessor roots", () => {
    expect(validatePredicate({ kind: "unknown", key: "actionResult.x", value: 1 })).toMatch(
      /unknown kind/,
    );
    expect(validatePredicate({ kind: "equals", key: "actionResult.x" })).toMatch(
      /requires "value"/,
    );
    expect(validatePredicate({ kind: "equals", key: "page.url", value: "x" })).toMatch(
      /not allowed/,
    );
    expect(validatePredicate({ kind: "between", key: "actionResult.x", lo: 0 })).toMatch(/numeric/);
    expect(
      validatePredicate({
        kind: "not",
        predicates: [
          { kind: "exists", key: "actionResult.x" },
          { kind: "exists", key: "actionResult.y" },
        ],
      }),
    ).toMatch(/exactly one/);
    expect(validatePredicate({ kind: "and", predicates: [] })).toMatch(/≥1/);
  });
});
