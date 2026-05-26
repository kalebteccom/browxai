import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PLAN_VERBS,
  clampTtl,
  validateVerbArgs,
  validateDescriptor,
  evidenceFromCandidate,
  buildDescriptor,
  estimateDescriptorTokens,
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
  const actual = (await orig()) as typeof import("./find.js");
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

describe("PLAN_VERBS — the action surface plan/execute covers", () => {
  it("is a fixed whitelist (no arbitrary-verb escape)", () => {
    expect([...PLAN_VERBS]).toEqual(["click", "fill", "hover", "press", "select"]);
  });
});

describe("clampTtl — descriptor lifetime bounds", () => {
  it("defaults to 60s when unset / non-finite", () => {
    expect(clampTtl(undefined)).toBe(60_000);
    expect(clampTtl(NaN)).toBe(60_000);
    // Infinity is non-finite → falls back to the default (then clamped a no-op).
    expect(clampTtl(Infinity)).toBe(60_000);
  });
  it("clamps below 1s up and above 30min down", () => {
    expect(clampTtl(0)).toBe(1_000);
    expect(clampTtl(-9999)).toBe(1_000);
    expect(clampTtl(60 * 60_000)).toBe(30 * 60_000);
  });
  it("passes through sane values", () => {
    expect(clampTtl(5_000)).toBe(5_000);
    expect(clampTtl(60_000)).toBe(60_000);
  });
});

describe("validateVerbArgs — per-verb args contract", () => {
  it("fill requires verbArgs.value (string)", () => {
    expect(validateVerbArgs("fill", undefined)).toMatch(/value/);
    expect(validateVerbArgs("fill", {})).toMatch(/value/);
    expect(validateVerbArgs("fill", { value: "hi" })).toBeNull();
  });
  it("press requires a non-empty key", () => {
    expect(validateVerbArgs("press", {})).toMatch(/key/);
    expect(validateVerbArgs("press", { key: "" })).toMatch(/key/);
    expect(validateVerbArgs("press", { key: "Enter" })).toBeNull();
  });
  it("select requires a non-empty values[]", () => {
    expect(validateVerbArgs("select", {})).toMatch(/values/);
    expect(validateVerbArgs("select", { values: [] })).toMatch(/values/);
    expect(validateVerbArgs("select", { values: ["a"] })).toBeNull();
  });
  it("click button must be left/right/middle when set", () => {
    expect(validateVerbArgs("click", undefined)).toBeNull();
    expect(validateVerbArgs("click", { button: "left" })).toBeNull();
    // @ts-expect-error — feeding an invalid literal on purpose
    expect(validateVerbArgs("click", { button: "wibble" })).toMatch(/button/);
  });
  it("hover takes no args", () => {
    expect(validateVerbArgs("hover", undefined)).toBeNull();
    expect(validateVerbArgs("hover", {})).toBeNull();
  });
});

describe("evidenceFromCandidate — projection from find() candidate", () => {
  it("captures the picked candidate's signals + top alternatives", () => {
    const picked = cand({ ref: "e7", score: 42, selectorHint: "#save", selectorTier: 4, stability: "low" });
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

describe("estimateDescriptorTokens", () => {
  it("returns a positive integer roughly tracking descriptor size", () => {
    const small = buildDescriptor({
      picked: cand(), alternatives: [], query: "x", verb: "click", verbArgs: {}, warnings: [], ttlMs: 1_000,
    });
    const big = buildDescriptor({
      picked: cand({ name: "x".repeat(500) }),
      alternatives: Array.from({ length: 4 }, (_, i) => cand({ ref: `e${i + 2}`, name: "y".repeat(200) })),
      query: "x", verb: "click", verbArgs: {}, warnings: [], ttlMs: 1_000,
    });
    expect(estimateDescriptorTokens(small)).toBeGreaterThan(0);
    expect(estimateDescriptorTokens(big)).toBeGreaterThan(estimateDescriptorTokens(small));
  });
});

describe("validateDescriptor — shape guard at execute() entry", () => {
  it("accepts a well-formed descriptor", () => {
    const d: ActionDescriptor = {
      id: "abc", ref: "e1", verb: "click", args: {},
      evidence: { query: "q", selectorHint: "#x", selectorTier: 1, stability: "high", role: "button", score: 1, actionable: true, warnings: [], alternatives: [] },
      expiresAt: Date.now() + 1000,
    };
    const r = validateDescriptor(d);
    expect(r.ok).toBe(true);
  });
  it("rejects non-objects, missing fields, and unknown verbs", () => {
    expect(validateDescriptor(null).ok).toBe(false);
    expect(validateDescriptor("nope").ok).toBe(false);
    expect(validateDescriptor({ id: "a", ref: "e1", verb: "fly", args: {}, expiresAt: 0 }).ok).toBe(false);
    expect(validateDescriptor({ id: "a", verb: "click", args: {}, expiresAt: 0 }).ok).toBe(false);
    expect(validateDescriptor({ id: "a", ref: "e1", verb: "click", expiresAt: 0 }).ok).toBe(false);
  });
});

describe("execute() — refusal modes (no dispatch happens)", () => {
  it("refuses an expired descriptor with reason 'expired' and never calls actions.*", async () => {
    const refs = new RefRegistry();
    refs.forKey("k1", { role: "button", name: "Save" });
    const d: ActionDescriptor = {
      id: "abc", ref: "e1", verb: "click", args: {},
      evidence: { query: "q", selectorHint: "#x", selectorTier: 1, stability: "high", role: "button", score: 1, actionable: true, warnings: [], alternatives: [] },
      expiresAt: 1_000,
    };
    const r = await execute(fakeCtx(refs), d, { now: 2_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
    expect(vi.mocked(actions.click)).not.toHaveBeenCalled();
  });

  it("refuses a ref-gone descriptor with reason 'ref-gone' and never calls actions.*", async () => {
    const refs = new RefRegistry(); // empty — ref doesn't exist
    const d: ActionDescriptor = {
      id: "abc", ref: "e1", verb: "click", args: {},
      evidence: { query: "q", selectorHint: "#x", selectorTier: 1, stability: "high", role: "button", score: 1, actionable: true, warnings: [], alternatives: [] },
      expiresAt: Date.now() + 60_000,
    };
    const r = await execute(fakeCtx(refs), d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ref-gone");
    expect(vi.mocked(actions.click)).not.toHaveBeenCalled();
  });

  it("refuses a structurally-invalid descriptor with reason 'invalid'", async () => {
    const refs = new RefRegistry();
    const r = await execute(fakeCtx(refs), { id: "x", verb: "wibble" } as unknown);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid");
  });

  it("re-validates verb args at execute time (a hand-edited descriptor that dropped value)", async () => {
    const refs = new RefRegistry();
    refs.forKey("k1", { role: "textbox", name: "Email" });
    const d: ActionDescriptor = {
      id: "abc", ref: "e1", verb: "fill", args: {}, // value missing
      evidence: { query: "q", selectorHint: "#x", selectorTier: 1, stability: "high", role: "textbox", score: 1, actionable: true, warnings: [], alternatives: [] },
      expiresAt: Date.now() + 60_000,
    };
    const r = await execute(fakeCtx(refs), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid");
      expect(r.error).toMatch(/value/);
    }
  });
});

describe("execute() — dispatch routing per verb", () => {
  it("click dispatches actions.click with the bound ref + button", async () => {
    const refs = new RefRegistry();
    refs.forKey("k1", { role: "button", name: "Save" });
    const d: ActionDescriptor = {
      id: "abc", ref: "e1", verb: "click", args: { button: "right" },
      evidence: { query: "q", selectorHint: "#x", selectorTier: 1, stability: "high", role: "button", score: 1, actionable: true, warnings: [], alternatives: [] },
      expiresAt: Date.now() + 60_000,
    };
    const r = await execute(fakeCtx(refs), d);
    expect(r.ok).toBe(true);
    expect(vi.mocked(actions.click)).toHaveBeenCalledTimes(1);
    const [, args] = vi.mocked(actions.click).mock.calls[0]!;
    expect(args.target).toEqual({ ref: "e1" });
    expect(args.button).toBe("right");
  });

  it("fill dispatches actions.fill with value", async () => {
    const refs = new RefRegistry();
    refs.forKey("k1", { role: "textbox", name: "Email" });
    const d: ActionDescriptor = {
      id: "abc", ref: "e1", verb: "fill", args: { value: "rowin@example.com" },
      evidence: { query: "q", selectorHint: "#x", selectorTier: 1, stability: "high", role: "textbox", score: 1, actionable: true, warnings: [], alternatives: [] },
      expiresAt: Date.now() + 60_000,
    };
    const r = await execute(fakeCtx(refs), d);
    expect(r.ok).toBe(true);
    const [, args] = vi.mocked(actions.fill).mock.calls[0]!;
    expect(args.target).toEqual({ ref: "e1" });
    expect(args.value).toBe("rowin@example.com");
  });

  it("press / hover / select route to their respective actions.*", async () => {
    const refs = new RefRegistry();
    refs.forKey("k1");
    refs.forKey("k2");
    refs.forKey("k3");
    const base = (verb: ActionDescriptor["verb"], ref: string, args: ActionDescriptor["args"]): ActionDescriptor => ({
      id: "abc", ref, verb, args,
      evidence: { query: "q", selectorHint: "#x", selectorTier: 1, stability: "high", role: "x", score: 1, actionable: true, warnings: [], alternatives: [] },
      expiresAt: Date.now() + 60_000,
    });
    await execute(fakeCtx(refs), base("press", "e1", { key: "Enter" }));
    await execute(fakeCtx(refs), base("hover", "e2", {}));
    await execute(fakeCtx(refs), base("select", "e3", { values: ["foo"] }));
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
      query: "nonexistent thing", verb: "click", testAttributes: [],
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
      query: "email input", verb: "fill", testAttributes: [], // missing verbArgs.value
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
      query: "the thing", verb: "click", testAttributes: [], confidenceFloor: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.descriptor.evidence.warnings.some((w) => /scored confidently/.test(w))).toBe(true);
  });

  it("named-ref descriptor: a descriptor bound to a named ref still dispatches via the same registry", async () => {
    // Named refs and plan's ref share the SAME `eN` namespace — no parallel
    // id system. We bind a name to a ref, then build a descriptor that
    // *carries the bound ref directly*; execute looks it up via refs.has().
    const refs = new RefRegistry();
    refs.forKey("k1", { role: "button", name: "Play" });
    refs.nameRef("play_btn", "e1");
    expect(refs.refByNameLookup("play_btn")).toBe("e1");

    vi.mocked(find).mockResolvedValueOnce({
      candidates: [cand({ ref: "e1", name: "Play" })],
      warnings: [],
    });
    const planned = await plan({} as never, {} as never, refs, {
      query: "play", verb: "click", testAttributes: [],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // The descriptor's ref is e1 — the same ref the name "play_btn" points
    // to. There is one namespace, not two; the name is an alias.
    expect(planned.descriptor.ref).toBe("e1");
    const dispatched = await execute(fakeCtx(refs), planned.descriptor);
    expect(dispatched.ok).toBe(true);
  });
});
