import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clampTtl,
  validateVerbArgs,
  validateDescriptor,
  evidenceFromCandidate,
  buildDescriptor,
  execute,
  plan,
  type ActionDescriptor,
} from "./plan.js";
import type { FindCandidate } from "./find.js";
import { RefRegistry } from "./refs.js";

// `execute()` is the dispatch seam. We mock `./actions.js` so the tests
// run without a real Playwright page, and so we can assert what was
// dispatched (target ref, verb-args propagation).
vi.mock("./actions.js", () => {
  const mk = (type: string) =>
    vi.fn(async (_ctx: unknown, args: unknown) => ({
      ok: true,
      action: { type, ...(args as Record<string, unknown>) },
      navigation: { changed: false, from: "", to: "", kind: null },
      structure: { appeared: [], removed: [], newTabs: [] },
      console: { errors: [], warnings: 0 },
      pageErrors: [],
      element: undefined,
      snapshotDelta: undefined,
      network: { summary: { total: 0 } },
      tokensEstimate: 42,
      warnings: [],
    }));
  return {
    click: mk("click"),
    fill: mk("fill"),
    hover: mk("hover"),
    press: mk("press"),
    select: mk("select"),
  };
});

// `find()` is the discovery seam. We mock it for the plan happy-path tests
// so they exercise the descriptor-building pipeline without spinning up a
// browser.
vi.mock("./find.js", async (orig) => {
  const actual = await orig<typeof import("./find.js")>();
  return { ...actual, find: vi.fn() };
});
import * as actions from "./actions.js";
import { find } from "./find.js";

function cand(over: Partial<FindCandidate> = {}): FindCandidate {
  return {
    ref: over.ref ?? "e1",
    role: over.role ?? "button",
    name: over.name ?? "Save",
    testId: over.testId,
    stability: over.stability ?? "high",
    selectorHint: over.selectorHint ?? '[data-testid="save"]',
    selectorTier: over.selectorTier ?? 1,
    bbox: over.bbox ?? null,
    clipped: over.clipped ?? false,
    actionable: over.actionable ?? true,
    score: over.score ?? 17,
    ...(over.context ? { context: over.context } : {}),
  };
}

// minimal fake context — execute() only touches ctx.refs.has(); the rest
// flows into the mocked actions.* which ignore it.
function fakeCtx(refs: RefRegistry) {
  return { refs } as unknown as import("./actionresult.js").ActionContext;
}

beforeEach(() => {
  vi.mocked(actions.click).mockClear();
  vi.mocked(actions.fill).mockClear();
  vi.mocked(actions.hover).mockClear();
  vi.mocked(actions.press).mockClear();
  vi.mocked(actions.select).mockClear();
  vi.mocked(find).mockReset();
});

describe("clampTtl — descriptor lifetime bounds", () => {
  it.each([
    ["unset defaults to 60s", undefined, 60_000],
    ["NaN defaults to 60s", NaN, 60_000],
    ["0 clamps up to 1s", 0, 1_000],
    ["an hour clamps down to 30min", 60 * 60_000, 30 * 60_000],
  ])("clampTtl: %s", (_name, input, expected) => {
    expect(clampTtl(input)).toBe(expected);
  });
});

describe("validateVerbArgs — per-verb args contract", () => {
  it.each<
    [
      string,
      Parameters<typeof validateVerbArgs>[0],
      Parameters<typeof validateVerbArgs>[1],
      RegExp | null,
    ]
  >([
    ["fill with no verbArgs", "fill", undefined, /value/],
    ["fill with a value", "fill", { value: "hi" }, null],
    ["press without a key", "press", {}, /key/],
    ["press with an empty key", "press", { key: "" }, /key/],
    ["press with a key", "press", { key: "Enter" }, null],
    ["select without values", "select", {}, /values/],
    ["select with an empty values[]", "select", { values: [] }, /values/],
    ["select with values", "select", { values: ["a"] }, null],
    ["click with no verbArgs", "click", undefined, null],
    ["click with button left", "click", { button: "left" }, null],
    ["click with an invalid button", "click", { button: "wibble" as never }, /button/],
  ])("validateVerbArgs: %s", (_name, verb, args, expected) => {
    const got = validateVerbArgs(verb, args);
    if (expected === null) expect(got).toBeNull();
    else expect(got).toMatch(expected);
  });
});

describe("evidenceFromCandidate — projection from find() candidate", () => {
  it("captures the picked candidate's signals + top alternatives", () => {
    const picked = cand({
      ref: "e7",
      score: 42,
      selectorHint: "#save",
      selectorTier: 4,
      stability: "low",
    });
    const alts = [cand({ ref: "e8", score: 20 }), cand({ ref: "e9", score: 10 })];
    const ev = evidenceFromCandidate("save button", picked, alts, ["low confidence"]);
    expect(ev.query).toBe("save button");
    expect(ev.selectorHint).toBe("#save");
    expect(ev.selectorTier).toBe(4);
    expect(ev.stability).toBe("low");
    expect(ev.score).toBe(42);
    expect(ev.warnings).toEqual(["low confidence"]);
    expect(ev.alternatives.map((a) => a.ref)).toEqual(["e8", "e9"]);
  });
  it("caps alternatives at 4 — the descriptor stays small even when find() returns many", () => {
    const picked = cand({ ref: "e1" });
    const alts = Array.from({ length: 10 }, (_, i) => cand({ ref: `e${i + 2}` }));
    const ev = evidenceFromCandidate("q", picked, alts, []);
    expect(ev.alternatives).toHaveLength(4);
  });
});

describe("buildDescriptor — assembled descriptor shape", () => {
  it("binds ref + verb + args + expiry off the picked candidate", () => {
    const d = buildDescriptor({
      picked: cand({ ref: "e5" }),
      alternatives: [],
      query: "q",
      verb: "fill",
      verbArgs: { value: "rowin@example.com" },
      warnings: [],
      ttlMs: 30_000,
      now: 1_000_000,
    });
    expect(d.ref).toBe("e5");
    expect(d.verb).toBe("fill");
    expect(d.args).toEqual({ value: "rowin@example.com" });
    expect(d.expiresAt).toBe(1_030_000);
    // id is a uuid-ish opaque string — just assert non-empty.
    expect(d.id).toMatch(/^[0-9a-f-]{8,}$/i);
  });
});

describe("validateDescriptor — shape guard at execute() entry", () => {
  it("rejects non-objects, missing fields, and unknown verbs", () => {
    expect(validateDescriptor(null).ok).toBe(false);
    expect(validateDescriptor("nope").ok).toBe(false);
    expect(validateDescriptor({ id: "a", ref: "e1", verb: "fly", args: {}, expiresAt: 0 }).ok).toBe(
      false,
    );
    expect(validateDescriptor({ id: "a", verb: "click", args: {}, expiresAt: 0 }).ok).toBe(false);
    expect(validateDescriptor({ id: "a", ref: "e1", verb: "click", expiresAt: 0 }).ok).toBe(false);
  });
});

function descriptorFor(
  verb: ActionDescriptor["verb"],
  args: ActionDescriptor["args"],
  over: Partial<ActionDescriptor> = {},
): ActionDescriptor {
  return {
    id: "abc",
    ref: "e1",
    verb,
    args,
    evidence: {
      query: "q",
      selectorHint: "#x",
      selectorTier: 1,
      stability: "high",
      role: "button",
      score: 1,
      actionable: true,
      warnings: [],
      alternatives: [],
    },
    expiresAt: Date.now() + 60_000,
    ...over,
  };
}

describe("execute() — refusal modes (no dispatch happens)", () => {
  it.each([
    ["an expired descriptor", "click", {}, { expiresAt: 1_000 }, 2_000, true, "expired", undefined],
    // empty registry: the ref doesn't exist
    ["a ref-gone descriptor", "click", {}, {}, undefined, false, "ref-gone", undefined],
    // a hand-edited descriptor that dropped value
    ["a fill descriptor missing its value", "fill", {}, {}, undefined, true, "invalid", /value/],
  ] as Array<
    [
      string,
      ActionDescriptor["verb"],
      ActionDescriptor["args"],
      Partial<ActionDescriptor>,
      number | undefined,
      boolean,
      string,
      RegExp | undefined,
    ]
  >)(
    "execute refuses %s and never calls actions.*",
    async (_name, verb, args, over, now, mint, reason, error) => {
      const refs = new RefRegistry();
      if (mint) refs.forKey("k1", { role: "button", name: "Save" });
      const r = await execute(
        fakeCtx(refs),
        descriptorFor(verb, args, over),
        now !== undefined ? { now } : {},
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(reason);
        if (error) expect(r.error).toMatch(error);
      }
      expect(vi.mocked(actions.click)).not.toHaveBeenCalled();
      expect(vi.mocked(actions.fill)).not.toHaveBeenCalled();
    },
  );
});

describe("execute() — dispatch routing per verb", () => {
  it.each([
    ["click", { button: "right" }, "button", "right"],
    ["fill", { value: "rowin@example.com" }, "value", "rowin@example.com"],
  ] as Array<[ActionDescriptor["verb"], ActionDescriptor["args"], string, string]>)(
    "%s dispatches its action with the bound ref and verb arg",
    async (verb, args, key, expected) => {
      const refs = new RefRegistry();
      refs.forKey("k1", { role: "button", name: "Save" });
      const r = await execute(fakeCtx(refs), descriptorFor(verb, args));
      expect(r.ok).toBe(true);
      const fn = vi.mocked(actions[verb as "click" | "fill"]);
      expect(fn).toHaveBeenCalledTimes(1);
      const [, called] = fn.mock.calls[0]!;
      expect(called.target).toEqual({ ref: "e1" });
      expect((called as unknown as Record<string, unknown>)[key]).toBe(expected);
    },
  );

  it("press / hover / select route to their respective actions.*", async () => {
    const refs = new RefRegistry();
    refs.forKey("k1");
    refs.forKey("k2");
    refs.forKey("k3");
    await execute(fakeCtx(refs), descriptorFor("press", { key: "Enter" }, { ref: "e1" }));
    await execute(fakeCtx(refs), descriptorFor("hover", {}, { ref: "e2" }));
    await execute(fakeCtx(refs), descriptorFor("select", { values: ["foo"] }, { ref: "e3" }));
    expect(vi.mocked(actions.press)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(actions.hover)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(actions.select)).toHaveBeenCalledTimes(1);
  });
});

describe("plan() — descriptor production from a find() candidate", () => {
  it("happy path: find() returns a candidate → plan returns a bound descriptor → execute dispatches it", async () => {
    const refs = new RefRegistry();
    refs.forKey("k1", { role: "button", name: "Save" }); // mints e1
    vi.mocked(find).mockResolvedValueOnce({
      candidates: [cand({ ref: "e1", name: "Save", score: 25 })],
      warnings: [],
    });
    const planned = await plan({} as never, {} as never, refs, {
      query: "save button",
      verb: "click",
      testAttributes: [],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.descriptor.ref).toBe("e1");
    expect(planned.descriptor.verb).toBe("click");
    expect(planned.descriptor.evidence.query).toBe("save button");
    expect(planned.descriptor.evidence.selectorHint).toBe('[data-testid="save"]');
    expect(planned.descriptor.expiresAt).toBeGreaterThan(Date.now());

    // execute the descriptor — should call actions.click with the bound ref.
    const dispatched = await execute(fakeCtx(refs), planned.descriptor);
    expect(dispatched.ok).toBe(true);
    expect(vi.mocked(actions.click)).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(actions.click).mock.calls[0]!;
    expect(args.target).toEqual({ ref: "e1" });
  });

  it("returns ok:false (not a descriptor) when find() returns no candidates", async () => {
    const refs = new RefRegistry();
    vi.mocked(find).mockResolvedValueOnce({ candidates: [], warnings: ["nothing matched"] });
    const r = await plan({} as never, {} as never, refs, {
      query: "nonexistent thing",
      verb: "click",
      testAttributes: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no candidate matched/);
      expect(r.warnings).toContain("nothing matched");
    }
  });

  it("rejects bad verbArgs up front — fill without value never calls find()", async () => {
    const refs = new RefRegistry();
    const r = await plan({} as never, {} as never, refs, {
      query: "email input",
      verb: "fill",
      testAttributes: [], // missing verbArgs.value
    });
    expect(r.ok).toBe(false);
    expect(vi.mocked(find)).not.toHaveBeenCalled();
  });

  it("forwards find() warnings into descriptor.evidence.warnings (so callers can refuse to execute on low confidence)", async () => {
    const refs = new RefRegistry();
    refs.forKey("k1");
    vi.mocked(find).mockResolvedValueOnce({
      candidates: [cand({ ref: "e1" })],
      warnings: ["no candidate scored confidently above 50 (top score: 3)"],
    });
    const r = await plan({} as never, {} as never, refs, {
      query: "the thing",
      verb: "click",
      testAttributes: [],
      confidenceFloor: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.descriptor.evidence.warnings.some((w) => /scored confidently/.test(w))).toBe(true);
  });
});
