import { describe, it, expect } from "vitest";
import type { Locator, Page } from "playwright-core";
import {
  fillForm,
  resolveFieldsAtomically,
  summariseTarget,
  validateFillFormArgs,
  type FillFormArgs,
  type FillFormField,
} from "./fill-form.js";
import type { ActionContext, ElementProbe } from "./actionresult.js";
import type { ActionTarget } from "./locator.js";

// ---------- mock plumbing ----------
//
// The fill-form primitive composes `runInActionWindow` (heavy machinery —
// CDP / a11y tree / network tap) with the existing `fill` lower-half. The
// behaviour worth testing in unit-land lives in the COMPOSITION layer:
//
//   - atomic pre-resolution (no partial writes)
//   - sequential dispatch order
//   - mid-loop failure → skipped tail
//   - secrets-masking still composes
//
// We isolate those by stubbing the smallest surface needed: a Page whose
// `locator()` returns scripted Locator stubs that record `.fill()` calls,
// and a RefRegistry stub that returns minimal locator-inputs.

interface ScriptedLocator {
  /** filled values, in the order .fill was called */
  fills: string[];
  /** count() return (default 1; 0 = unresolved) */
  count: number;
  /** if true, .fill throws — exercises the mid-loop-failure path */
  failFill?: boolean;
  loc: Locator;
}

function mkLocator(opts: { count?: number; failFill?: boolean } = {}): ScriptedLocator {
  const fills: string[] = [];
  const count = opts.count ?? 1;
  // The locator stub returns itself for `.first()` so chained calls work the
  // same way Playwright's real Locator does (`.first()` returns a Locator).
  const loc: Locator = {} as Locator;
  Object.assign(loc, {
    count: async () => count,
    first: () => loc,
    fill: async (v: string) => {
      if (opts.failFill) throw new Error("scripted fill failure");
      fills.push(v);
    },
    click: async () => {
      // submit-target stub: a click drives nothing — we only assert that
      // .click() was reached by checking the per-field probe lengths line up
      // with expectations from the test.
    },
    inputValue: async () => fills[fills.length - 1] ?? "",
    evaluate: async () => null,
    waitFor: async () => undefined,
    scrollIntoViewIfNeeded: async () => undefined,
  });
  return { fills, count, loc, ...(opts.failFill ? { failFill: true } : {}) };
}

interface MockRefs {
  byRef: Map<string, ScriptedLocator>;
}

function mkCtx(byRef: Map<string, ScriptedLocator>): ActionContext {
  // Minimal RefRegistry surface: just what locator.locatorFor() touches.
  const refs = {
    locatorOf: (ref: string) => {
      if (!byRef.has(ref)) return undefined;
      // The real registry returns RefLocatorInputs (role/name/testId/etc.);
      // we don't go through that path because our Page.locator() / Page.getByRole()
      // are scripted to return the same per-ref Locator object regardless of
      // tier-routing. Returning a stub with `cssPath` triggers the cssPath
      // branch in locatorFromInputs(), which calls page.locator(path).
      return { role: "textbox", source: "both", cssPath: `[data-ref="${ref}"]` };
    },
    refByNameLookup: () => undefined,
    refByName: () => undefined,
  } as unknown as ActionContext["refs"];

  const page = {
    locator: (sel: string) => {
      // sel is `[data-ref="<ref>"]` from locatorFromInputs's cssPath branch
      const m = sel.match(/^\[data-ref="([^"]+)"\]$/);
      if (m) {
        const stub = byRef.get(m[1]!);
        if (stub) return stub.loc;
      }
      // Unknown selector — return a zero-count locator so the resolution
      // step records a miss.
      return mkLocator({ count: 0 }).loc;
    },
    getByRole: () => mkLocator({ count: 0 }).loc,
    url: () => "https://example.test/",
  } as unknown as Page;

  // We only need `page` + `refs` for the unit tests that go through
  // `resolveFieldsAtomically` and `validateFillFormArgs`. The full
  // `fillForm` test uses a heavier ctx mocked further below.
  return { page, refs } as unknown as ActionContext;
}

// ---------- pure helpers ----------

describe("summariseTarget — agent-facing error summaries", () => {
  it("renders ref targets compactly", () => {
    expect(summariseTarget({ ref: "e7" } as ActionTarget)).toBe("ref=e7");
  });
  it("renders selector targets, scoped or unscoped", () => {
    expect(summariseTarget({ selector: ".x" } as ActionTarget)).toBe("selector=.x");
    expect(summariseTarget({ selector: ".x", contextRef: "e2" } as ActionTarget))
      .toBe("selector=.x (in e2)");
  });
  it("renders coords targets (relevant for the submit slot)", () => {
    expect(summariseTarget({ coords: { x: 10, y: 20 } } as ActionTarget)).toBe("coords=10,20");
  });
});

describe("validateFillFormArgs — shape guards before touching the page", () => {
  it("rejects empty `fields`", () => {
    expect(() => validateFillFormArgs({ fields: [] } as unknown as FillFormArgs))
      .toThrow(/non-empty array/);
  });
  it("rejects a field missing `target`", () => {
    expect(() =>
      validateFillFormArgs({
        fields: [{ value: "hi" } as unknown as FillFormField],
      } as FillFormArgs),
    ).toThrow(/target is required/);
  });
  it("rejects non-string values", () => {
    expect(() =>
      validateFillFormArgs({
        fields: [{ target: { ref: "e1" }, value: 42 as unknown as string }],
      } as FillFormArgs),
    ).toThrow(/must be a string/);
  });
  it("rejects coords targets — fill needs a real input element", () => {
    expect(() =>
      validateFillFormArgs({
        fields: [{ target: { coords: { x: 1, y: 1 } } as ActionTarget, value: "hi" }],
      } as FillFormArgs),
    ).toThrow(/coords target/);
  });
  it("accepts a well-formed args block", () => {
    expect(() =>
      validateFillFormArgs({
        fields: [
          { target: { ref: "e1" }, value: "alice" },
          { target: { ref: "e2" }, value: "alice@example.test" },
        ],
      } as FillFormArgs),
    ).not.toThrow();
  });
});

// ---------- atomic resolution ----------

describe("resolveFieldsAtomically — every target resolved or NONE write", () => {
  it("succeeds when every field resolves to >=1 DOM node", async () => {
    const byRef = new Map<string, ScriptedLocator>([
      ["e1", mkLocator()],
      ["e2", mkLocator()],
    ]);
    const ctx = mkCtx(byRef);
    const r = await resolveFieldsAtomically(ctx.page, ctx.refs, [
      { target: { ref: "e1" }, value: "a" },
      { target: { ref: "e2" }, value: "b" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.locators).toHaveLength(2);
      expect(r.resolutions.every((x) => x.ok)).toBe(true);
    }
  });

  it("rejects atomically when ONE field misses (no partial-fill follow-on)", async () => {
    const byRef = new Map<string, ScriptedLocator>([
      ["e1", mkLocator()],
      ["e_missing", mkLocator({ count: 0 })],
      ["e3", mkLocator()],
    ]);
    const ctx = mkCtx(byRef);
    const r = await resolveFieldsAtomically(ctx.page, ctx.refs, [
      { target: { ref: "e1" }, value: "a" },
      { target: { ref: "e_missing" }, value: "b" },
      { target: { ref: "e3" }, value: "c" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.resolutions[0]?.ok).toBe(true);
      expect(r.resolutions[1]?.ok).toBe(false);
      expect(r.resolutions[1]?.error).toMatch(/zero DOM nodes/);
      // Even resolutions AFTER the miss are reported — agent sees the
      // whole picture, not just the first failure.
      expect(r.resolutions[2]?.ok).toBe(true);
    }
    // And the well-resolved field's locator was NOT acted on: this is the
    // atomic invariant. We assert by inspecting the scripted Locator's
    // `fills` buffer — empty means no .fill() ever happened.
    expect(byRef.get("e1")!.fills).toHaveLength(0);
    expect(byRef.get("e3")!.fills).toHaveLength(0);
  });

  it("rejects when the submit target is unresolved (atomic on submit too)", async () => {
    const byRef = new Map<string, ScriptedLocator>([
      ["e1", mkLocator()],
      ["submit_missing", mkLocator({ count: 0 })],
    ]);
    const ctx = mkCtx(byRef);
    const r = await resolveFieldsAtomically(
      ctx.page,
      ctx.refs,
      [{ target: { ref: "e1" }, value: "a" }],
      { ref: "submit_missing" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.submitResolution?.ok).toBe(false);
      expect(r.submitResolution?.error).toMatch(/zero DOM nodes/);
    }
  });

  it("surfaces an unknown-ref registry error as a structured miss, not a thrown exception", async () => {
    const byRef = new Map<string, ScriptedLocator>([["e1", mkLocator()]]);
    const ctx = mkCtx(byRef);
    const r = await resolveFieldsAtomically(ctx.page, ctx.refs, [
      { target: { ref: "e_unknown" }, value: "a" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.resolutions[0]?.ok).toBe(false);
      expect(r.resolutions[0]?.error).toMatch(/unknown ref/);
    }
  });
});

// ---------- fillForm composition — atomic-failure result envelope ----------
//
// We don't drive the full action-window machinery (network tap / CDP / a11y
// tree) under unit tests — that's keystone territory. What we DO assert is:
// when atomic pre-resolution rejects, the result envelope returned by
// fillForm() is well-formed, ok:false, carries `fieldResolution`, and *no*
// scripted Locator was filled.

describe("fillForm — atomic-failure result envelope (no partial fills)", () => {
  it("returns ok:false with fieldResolution and zero fills when ANY field misses", async () => {
    const byRef = new Map<string, ScriptedLocator>([
      ["e1", mkLocator()],
      ["e_missing", mkLocator({ count: 0 })],
    ]);
    const ctx = mkCtx(byRef);
    const r = await fillForm(ctx, {
      fields: [
        { target: { ref: "e1" }, value: "alice" },
        { target: { ref: "e_missing" }, value: "alice@example.test" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.action.type).toBe("fillForm");
    expect(r.action.value).toBe("2 fields");
    expect(r.error).toMatch(/atomic pre-resolution rejected/);
    expect(r.fieldResolution).toBeDefined();
    expect(r.fieldResolution!.find((x) => !x.ok)?.targetSummary).toBe("ref=e_missing");

    // The atomic invariant: the resolvable field was NOT typed into.
    expect(byRef.get("e1")!.fills).toHaveLength(0);
  });

  it("includes the submit miss in fieldResolution when only the submit fails to resolve", async () => {
    const byRef = new Map<string, ScriptedLocator>([
      ["e1", mkLocator()],
      ["e2", mkLocator()],
      ["submit_missing", mkLocator({ count: 0 })],
    ]);
    const ctx = mkCtx(byRef);
    const r = await fillForm(ctx, {
      fields: [
        { target: { ref: "e1" }, value: "alice" },
        { target: { ref: "e2" }, value: "alice@example.test" },
      ],
      submit: { ref: "submit_missing" },
    });
    expect(r.ok).toBe(false);
    expect(r.action.value).toBe("2 fields +submit");
    const submitEntry = r.fieldResolution?.find((x) => x.targetSummary.startsWith("submit "));
    expect(submitEntry?.ok).toBe(false);

    // Atomic even on submit failure: zero fills landed.
    expect(byRef.get("e1")!.fills).toHaveLength(0);
    expect(byRef.get("e2")!.fills).toHaveLength(0);
  });

  it("rejects coords field targets at validation time (fill needs a real element)", async () => {
    const ctx = mkCtx(new Map());
    await expect(
      fillForm(ctx, {
        fields: [{ target: { coords: { x: 1, y: 1 } } as ActionTarget, value: "x" }],
      }),
    ).rejects.toThrow(/coords target/);
  });
});

// ---------- secrets masking composes ----------

describe("fillForm — secrets-masking composes through the loop", () => {
  it("rejects atomically when ANY field's secret materialisation fails — no fills", async () => {
    const byRef = new Map<string, ScriptedLocator>([
      ["e1", mkLocator()],
      ["e2", mkLocator()],
    ]);
    const ctx = mkCtx(byRef);
    // Stand in a minimal SecretRegistry that rejects the second field's
    // `<SCOPED>` alias because the page URL doesn't match its scope. The
    // first field uses a plain string and would normally pass — we assert
    // it's NOT typed in.
    const fakeSecrets = {
      materialize: (raw: string) => {
        if (raw === "alice") return { ok: true as const, value: "alice" };
        if (raw === "<SCOPED>") {
          return { ok: false as const, error: "scope mismatch: page URL doesn't include scope" };
        }
        return { ok: true as const, value: raw };
      },
      applyMaskInText: (s: string) => s,
    };
    (ctx as unknown as { secrets: typeof fakeSecrets }).secrets = fakeSecrets;

    const r = await fillForm(ctx, {
      fields: [
        { target: { ref: "e1" }, value: "alice" },
        { target: { ref: "e2" }, value: "<SCOPED>" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/secrets materialisation rejected fields\[1\]/);
    // First field NOT typed in — atomic invariant holds across secrets too.
    expect(byRef.get("e1")!.fills).toHaveLength(0);
  });
});

// ---------- descriptor shape ----------

describe("fillForm — descriptor value tag", () => {
  it("uses singular 'field' for n=1", async () => {
    const byRef = new Map<string, ScriptedLocator>([["bad", mkLocator({ count: 0 })]]);
    const ctx = mkCtx(byRef);
    const r = await fillForm(ctx, { fields: [{ target: { ref: "bad" }, value: "x" }] });
    expect(r.action.value).toBe("1 field");
  });
  it("renders +submit when a submit is supplied", async () => {
    const byRef = new Map<string, ScriptedLocator>([["bad", mkLocator({ count: 0 })]]);
    const ctx = mkCtx(byRef);
    const r = await fillForm(ctx, {
      fields: [{ target: { ref: "bad" }, value: "x" }],
      submit: { ref: "also_bad" },
    });
    expect(r.action.value).toBe("1 field +submit");
  });
});

// Compile-time guard: the ElementProbe shape is what we surface per-field.
// If the upstream type drifts this fails to compile, catching silent
// breakage in the docs contract.
const _shapeGuard: ElementProbe[] = [
  { ref: "e1", stillAttached: true, value: "alice", valueRequested: "alice" },
];
void _shapeGuard;
