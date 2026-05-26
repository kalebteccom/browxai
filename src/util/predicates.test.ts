import { describe, it, expect } from "vitest";
import {
  evaluatePredicate,
  validatePredicate,
  resolveKey,
  isAllowedKey,
  allowedKeyRoots,
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
  it("accepts allow-listed roots", () => {
    expect(isAllowedKey("actionResult")).toBe(true);
    expect(isAllowedKey("actionResult.element.value")).toBe(true);
    expect(isAllowedKey("snapshot.warnings.length")).toBe(true);
    expect(isAllowedKey("element.foo")).toBe(true);
    expect(isAllowedKey("expect.valueEquals")).toBe(true);
  });

  it("rejects unknown roots (no arbitrary-prefix drill)", () => {
    expect(isAllowedKey("page.url")).toBe(false);
    expect(isAllowedKey("__proto__.toString")).toBe(false);
    expect(isAllowedKey("")).toBe(false);
  });

  it("publishes the root list for docs / errors", () => {
    const roots = allowedKeyRoots();
    expect(roots).toContain("actionResult");
    expect(roots).toContain("snapshot");
    // sorted for stable display
    const sorted = [...roots].sort();
    expect(roots).toEqual(sorted);
  });
});

describe("resolveKey", () => {
  it("returns nested values via dotted access", () => {
    expect(resolveKey(SAMPLE, "actionResult.element.value")).toBe("hello world");
    expect(resolveKey(SAMPLE, "actionResult.navigation.kind")).toBe("spa");
  });

  it("handles .length over arrays and strings", () => {
    expect(resolveKey(SAMPLE, "actionResult.console.errors.length")).toBe(1);
    expect(resolveKey(SAMPLE, "actionResult.element.value.length")).toBe("hello world".length);
    expect(resolveKey(SAMPLE, "snapshot.warnings.length")).toBe(2);
  });

  it("returns undefined for missing intermediates without throwing", () => {
    expect(resolveKey(SAMPLE, "actionResult.missing.path")).toBeUndefined();
  });

  it("returns undefined for non-allow-listed keys", () => {
    expect(resolveKey(SAMPLE, "globalThis.process")).toBeUndefined();
  });
});

describe("evaluatePredicate — leaf kinds", () => {
  const data = SAMPLE;

  it("equals matches strict-equal scalars", () => {
    expect(evaluatePredicate({ kind: "equals", key: "actionResult.element.value", value: "hello world" }, data).ok).toBe(true);
    const fail = evaluatePredicate({ kind: "equals", key: "actionResult.element.value", value: "nope" }, data);
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.kind).toBe("equals");
      expect(fail.actual).toBe("hello world");
      expect(fail.expected).toContain("equals");
    }
  });

  it("notEquals inverts equals", () => {
    expect(evaluatePredicate({ kind: "notEquals", key: "actionResult.element.value", value: "no" }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "notEquals", key: "actionResult.element.value", value: "hello world" }, data).ok).toBe(false);
  });

  it("contains works on strings and arrays", () => {
    expect(evaluatePredicate({ kind: "contains", key: "actionResult.element.value", value: "world" }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "contains", key: "actionResult.console.errors", value: "one" }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "contains", key: "actionResult.console.errors", value: "absent" }, data).ok).toBe(false);
  });

  it("gt / lt / gte / lte are numeric and reject non-numbers", () => {
    expect(evaluatePredicate({ kind: "gt", key: "actionResult.network.summary.total", value: 5 }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "lt", key: "actionResult.network.summary.total", value: 10 }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "gte", key: "actionResult.network.summary.total", value: 7 }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "lte", key: "actionResult.network.summary.total", value: 7 }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "gt", key: "actionResult.element.value", value: 3 }, data).ok).toBe(false);
  });

  it("between is inclusive numeric", () => {
    expect(evaluatePredicate({ kind: "between", key: "actionResult.network.summary.total", lo: 0, hi: 10 }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "between", key: "actionResult.network.summary.total", lo: 8, hi: 10 }, data).ok).toBe(false);
  });

  it("matches takes a regex string", () => {
    expect(evaluatePredicate({ kind: "matches", key: "actionResult.navigation.to", value: "^https://example\\.com" }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "matches", key: "actionResult.navigation.to", value: "nope" }, data).ok).toBe(false);
  });

  it("exists checks non-null/undefined", () => {
    expect(evaluatePredicate({ kind: "exists", key: "actionResult.element.value" }, data).ok).toBe(true);
    expect(evaluatePredicate({ kind: "exists", key: "actionResult.missing" }, data).ok).toBe(false);
  });

  it("fails loudly when key root isn't allow-listed", () => {
    const fail = evaluatePredicate({ kind: "equals", key: "foo.bar", value: "x" }, data);
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.expected).toContain("allow-list");
  });
});

describe("evaluatePredicate — and / or / not", () => {
  it("and: all children must pass", () => {
    const pred: Predicate = {
      kind: "and",
      predicates: [
        { kind: "contains", key: "actionResult.element.value", value: "hello" },
        { kind: "equals", key: "actionResult.navigation.kind", value: "spa" },
      ],
    };
    expect(evaluatePredicate(pred, SAMPLE).ok).toBe(true);
    const broken: Predicate = {
      kind: "and",
      predicates: [
        { kind: "contains", key: "actionResult.element.value", value: "hello" },
        { kind: "equals", key: "actionResult.navigation.kind", value: "wrong" },
      ],
    };
    const r = evaluatePredicate(broken, SAMPLE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("and");
      expect(r.expected).toContain("and(child[1]");
    }
  });

  it("or: short-circuits on the first passing child", () => {
    const pred: Predicate = {
      kind: "or",
      predicates: [
        { kind: "equals", key: "actionResult.navigation.kind", value: "full_load" }, // fails
        { kind: "equals", key: "actionResult.navigation.kind", value: "spa" },       // passes
      ],
    };
    expect(evaluatePredicate(pred, SAMPLE).ok).toBe(true);
  });

  it("or: fails with structured per-child actuals when none hold", () => {
    const pred: Predicate = {
      kind: "or",
      predicates: [
        { kind: "equals", key: "actionResult.navigation.kind", value: "a" },
        { kind: "equals", key: "actionResult.navigation.kind", value: "b" },
      ],
    };
    const r = evaluatePredicate(pred, SAMPLE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("or");
      expect(Array.isArray(r.actual)).toBe(true);
    }
  });

  it("not: inverts the child predicate", () => {
    const yes: Predicate = {
      kind: "not",
      predicates: [{ kind: "equals", key: "actionResult.navigation.kind", value: "full_load" }],
    };
    expect(evaluatePredicate(yes, SAMPLE).ok).toBe(true);
    const no: Predicate = {
      kind: "not",
      predicates: [{ kind: "equals", key: "actionResult.navigation.kind", value: "spa" }],
    };
    expect(evaluatePredicate(no, SAMPLE).ok).toBe(false);
  });

  it("nested combinators evaluate recursively", () => {
    const pred: Predicate = {
      kind: "and",
      predicates: [
        { kind: "exists", key: "actionResult.element.value" },
        {
          kind: "or",
          predicates: [
            { kind: "equals", key: "actionResult.navigation.kind", value: "spa" },
            { kind: "equals", key: "actionResult.navigation.kind", value: "hash" },
          ],
        },
        {
          kind: "not",
          predicates: [{ kind: "gt", key: "actionResult.console.errors.length", value: 5 }],
        },
      ],
    };
    expect(evaluatePredicate(pred, SAMPLE).ok).toBe(true);
  });
});

describe("validatePredicate", () => {
  it("accepts well-formed leaves and composites", () => {
    expect(validatePredicate({ kind: "equals", key: "actionResult.x", value: 1 })).toBeNull();
    expect(validatePredicate({ kind: "between", key: "snapshot.warnings.length", lo: 0, hi: 5 })).toBeNull();
    expect(validatePredicate({ kind: "exists", key: "actionResult.element" })).toBeNull();
    expect(validatePredicate({
      kind: "and",
      predicates: [{ kind: "equals", key: "actionResult.x", value: 1 }],
    })).toBeNull();
  });

  it("rejects unknown kinds, missing fields, and bad accessor roots", () => {
    expect(validatePredicate({ kind: "unknown", key: "actionResult.x", value: 1 })).toMatch(/unknown kind/);
    expect(validatePredicate({ kind: "equals", key: "actionResult.x" })).toMatch(/requires "value"/);
    expect(validatePredicate({ kind: "equals", key: "page.url", value: "x" })).toMatch(/not allowed/);
    expect(validatePredicate({ kind: "between", key: "actionResult.x", lo: 0 })).toMatch(/numeric/);
    expect(validatePredicate({ kind: "not", predicates: [{ kind: "exists", key: "actionResult.x" }, { kind: "exists", key: "actionResult.y" }] })).toMatch(/exactly one/);
    expect(validatePredicate({ kind: "and", predicates: [] })).toMatch(/≥1/);
  });
});
