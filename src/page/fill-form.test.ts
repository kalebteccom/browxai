import { describe, it, expect } from "vitest";
import type { Locator, Page } from "playwright-core";
import {
  fillForm,
  resolveFieldsAtomically,
  summariseTarget,
  validateFillFormArgs,
  type FillFormField,
} from "./fill-form.js";
import type { ActionContext, ElementProbe } from "./actionresult.js";

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
    frameOf: () => undefined,
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
  it.each([
    { name: "an unscoped selector target", target: { selector: ".x" }, summary: "selector=.x" },
    {
      name: "a scoped selector target",
      target: { selector: ".x", contextRef: "e2" },
      summary: "selector=.x (in e2)",
    },
    {
      name: "a coords target (relevant for the submit slot)",
      target: { coords: { x: 10, y: 20 } },
      summary: "coords=10,20",
    },
  ])("renders $name", ({ target, summary }) => {
    expect(summariseTarget(target)).toBe(summary);
  });
});

describe("validateFillFormArgs — shape guards before touching the page", () => {
  it.each([
    { name: "empty `fields`", fields: [], error: /non-empty array/ },
    {
      name: "a field missing `target`",
      fields: [{ value: "hi" } as unknown as FillFormField],
      error: /target is required/,
    },
    {
      name: "non-string values",
      fields: [{ target: { ref: "e1" }, value: 42 as unknown as string }],
      error: /must be a string/,
    },
    {
      name: "coords targets (fill needs a real input element)",
      fields: [{ target: { coords: { x: 1, y: 1 } }, value: "hi" }],
      error: /coords target/,
    },
  ])("rejects $name", ({ fields, error }) => {
    expect(() => validateFillFormArgs({ fields })).toThrow(error);
  });
});

// ---------- atomic resolution ----------

describe("resolveFieldsAtomically — every target resolved or NONE write", () => {
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
      // No frame receiver in this fake ctx, so materialize checks the page URL.
      needsScopeCheck: () => false,
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

// Compile-time guard: the ElementProbe shape is what we surface per-field.
// If the upstream type drifts this fails to compile, catching silent
// breakage in the docs contract.
const _shapeGuard: ElementProbe[] = [
  { ref: "e1", stillAttached: true, value: "alice", valueRequested: "alice" },
];
void _shapeGuard;
