import { describe, it, expect } from "vitest";
import {
  runFlakeCheck,
  rollUpSteps,
  findFirstDivergence,
  extractCachedResolvers,
  signatureFor,
} from "./flake-check.js";
import type { ToolHandler } from "./batch.js";
import { runBatch } from "./batch.js";

const ALLOWED = new Set([
  "click",
  "fill",
  "navigate",
  "snapshot",
  "wait_for",
  "find",
  "plan",
  "execute",
]);

function jsonHandler(body: object): ToolHandler {
  return async () => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
}

/** Build a handler whose response varies per call. The first response is
 *  index 0; subsequent calls walk the list. The last entry is reused if the
 *  list runs out (so a "stable response" handler is just `[response]`). */
function scriptedHandler(responses: object[]): ToolHandler {
  let i = 0;
  return async () => {
    const idx = Math.min(i, responses.length - 1);
    i++;
    return { content: [{ type: "text", text: JSON.stringify(responses[idx]) }] };
  };
}

describe("runFlakeCheck — repetition + roll-up", () => {
  it("runs N times and reports allGreen when every step passes every run", async () => {
    const handlers = { navigate: jsonHandler({ ok: true }), click: jsonHandler({ ok: true }) };
    const report = await runFlakeCheck(
      [{ tool: "navigate" }, { tool: "click", args: { ref: "e1" } }],
      { n: 5, allowed: ALLOWED, handlers },
    );
    expect(report.runsCompleted).toBe(5);
    expect(report.allGreen).toBe(true);
    expect(report.firstDivergence).toBeNull();
    expect(report.steps.map((s) => s.successRate)).toEqual([1, 1]);
  });

  it("captures per-step success rate when one step flakes", async () => {
    // step 1 alternates ok/fail
    const click = scriptedHandler([
      { ok: true },
      { ok: false, error: "boom" },
      { ok: true },
      { ok: false, error: "boom" },
      { ok: true },
    ]);
    const handlers = { navigate: jsonHandler({ ok: true }), click };
    const report = await runFlakeCheck(
      [{ tool: "navigate" }, { tool: "click", args: { ref: "e1" } }],
      { n: 5, allowed: ALLOWED, handlers },
    );
    expect(report.runsCompleted).toBe(5);
    expect(report.allGreen).toBe(false);
    expect(report.steps[1]!.ok).toBe(3);
    expect(report.steps[1]!.runs).toBe(5);
    expect(report.steps[1]!.successRate).toBeCloseTo(0.6);
    expect(report.steps[1]!.errors).toContain("boom");
  });

  it("records first-divergence at the earliest step where ok shifted", async () => {
    const handlers = {
      navigate: jsonHandler({ ok: true }),
      click: scriptedHandler([{ ok: true }, { ok: false, error: "x" }]),
      fill: jsonHandler({ ok: true }),
    };
    const report = await runFlakeCheck(
      [
        { tool: "navigate" },
        { tool: "click", args: { ref: "e1" }, label: "submit" },
        { tool: "fill", args: { ref: "e2" } },
      ],
      { n: 2, allowed: ALLOWED, handlers },
    );
    expect(report.firstDivergence).toEqual({ step: 1, tool: "click", label: "submit" });
  });

  it("findFirstDivergence returns null when every run agrees per step", () => {
    const calls = [{ tool: "click" }];
    const allOk = [
      {
        completed: 1,
        failedAt: null,
        results: [{ tool: "click", ok: true, result: { ok: true } }],
      },
      {
        completed: 1,
        failedAt: null,
        results: [{ tool: "click", ok: true, result: { ok: true } }],
      },
    ];
    expect(findFirstDivergence(calls, allOk)).toBeNull();
    // ALL fail is also agreement → null.
    const allFail = [
      { completed: 1, failedAt: 0, results: [{ tool: "click", ok: false, error: "x" }] },
      { completed: 1, failedAt: 0, results: [{ tool: "click", ok: false, error: "y" }] },
    ];
    expect(findFirstDivergence(calls, allFail)).toBeNull();
  });
});

describe("runFlakeCheck — stopOnAllGreen short-circuit", () => {
  it("breaks early once stopOnAllGreen consecutive runs are all-green", async () => {
    let calls = 0;
    const navigate: ToolHandler = async () => {
      calls++;
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    };
    const report = await runFlakeCheck([{ tool: "navigate" }], {
      n: 10,
      stopOnAllGreen: 3,
      allowed: ALLOWED,
      handlers: { navigate },
    });
    expect(report.runsCompleted).toBe(3);
    expect(report.shortCircuitedAfter).toBe(3);
    expect(calls).toBe(3);
  });

  it("does NOT short-circuit when a failure breaks the all-green streak", async () => {
    const click = scriptedHandler([
      { ok: true },
      { ok: false, error: "flake" },
      { ok: true },
      { ok: true },
    ]);
    const report = await runFlakeCheck([{ tool: "click", args: { ref: "e1" } }], {
      n: 4,
      stopOnAllGreen: 3,
      allowed: ALLOWED,
      handlers: { click },
    });
    // runs 1,2 green-then-fail resets the streak; runs 3,4 give 2 consecutive
    // green — below the threshold — so we run the full N.
    expect(report.runsCompleted).toBe(4);
    expect(report.shortCircuitedAfter).toBeUndefined();
  });

  it("requires `stopOnAllGreen` to be set explicitly; default behaviour runs all N", async () => {
    const handlers = { navigate: jsonHandler({ ok: true }) };
    const report = await runFlakeCheck([{ tool: "navigate" }], {
      n: 4,
      allowed: ALLOWED,
      handlers,
    });
    expect(report.runsCompleted).toBe(4);
    expect(report.shortCircuitedAfter).toBeUndefined();
  });
});

describe("runFlakeCheck — cached-selector artifact", () => {
  it("emits a descriptor-shaped resolver for a `plan` step where every run agreed", async () => {
    const planResp = {
      ok: true,
      descriptor: {
        id: "d-1",
        ref: "e7",
        verb: "click",
        args: {},
        evidence: {
          selectorHint: 'role=button[name="Save"]',
          selectorTier: 2,
          stability: "medium",
          role: "button",
          name: "Save",
          score: 0.9,
          actionable: true,
          warnings: [],
        },
        expiresAt: Date.now() + 60_000,
      },
    };
    const handlers = {
      plan: jsonHandler(planResp),
      execute: jsonHandler({ ok: true, result: { ok: true } }),
    };
    const report = await runFlakeCheck(
      [
        { tool: "plan", args: { query: "save", verb: "click" }, label: "plan save" },
        { tool: "execute", args: {} },
      ],
      { n: 3, allowed: ALLOWED, handlers },
    );
    expect(report.allGreen).toBe(true);
    const planCache = report.cachedResolvers.find((c) => c.tool === "plan");
    expect(planCache).toBeDefined();
    expect(planCache!.ref).toBe("e7");
    expect(planCache!.selectorHint).toBe('role=button[name="Save"]');
    expect(planCache!.descriptor).toBeDefined();
    expect(planCache!.descriptor!.verb).toBe("click");
    expect(planCache!.descriptor!.evidence!.role).toBe("button");
    expect(planCache!.agreedRuns).toBe(3);
  });

  it("emits a bound-target resolver for a `click({ref:'eN'})` step that passed every run", async () => {
    const handlers = { click: jsonHandler({ ok: true, element: { value: "x" } }) };
    const report = await runFlakeCheck([{ tool: "click", args: { ref: "e3" }, label: "submit" }], {
      n: 3,
      allowed: ALLOWED,
      handlers,
    });
    expect(report.cachedResolvers).toHaveLength(1);
    expect(report.cachedResolvers[0]!.ref).toBe("e3");
    expect(report.cachedResolvers[0]!.descriptor).toBeUndefined();
    expect(report.cachedResolvers[0]!.label).toBe("submit");
  });

  it("does NOT cache a step that flaked (some runs failed)", async () => {
    const click = scriptedHandler([{ ok: true }, { ok: false, error: "flake" }, { ok: true }]);
    const report = await runFlakeCheck([{ tool: "click", args: { ref: "e3" } }], {
      n: 3,
      allowed: ALLOWED,
      handlers: { click },
    });
    expect(report.cachedResolvers).toHaveLength(0);
    expect(report.steps[0]!.errors).toContain("flake");
  });

  it("does NOT cache a `plan` step whose top candidate drifted across runs", async () => {
    // Two runs land on e7, one on e9 — disagreement on the resolution signature.
    const plan = scriptedHandler([
      {
        ok: true,
        descriptor: {
          ref: "e7",
          verb: "click",
          args: {},
          evidence: { selectorHint: "role=button[name=Save]" },
          expiresAt: 0,
        },
      },
      {
        ok: true,
        descriptor: {
          ref: "e9",
          verb: "click",
          args: {},
          evidence: { selectorHint: "role=button[name=Save (1)]" },
          expiresAt: 0,
        },
      },
      {
        ok: true,
        descriptor: {
          ref: "e7",
          verb: "click",
          args: {},
          evidence: { selectorHint: "role=button[name=Save]" },
          expiresAt: 0,
        },
      },
    ]);
    const report = await runFlakeCheck([{ tool: "plan", args: { query: "save", verb: "click" } }], {
      n: 3,
      allowed: ALLOWED,
      handlers: { plan },
    });
    expect(report.cachedResolvers).toHaveLength(0);
    expect(report.steps[0]!.signatures.length).toBeGreaterThan(1);
  });

  it("emits a find-style resolver from a `find` step's top candidate", async () => {
    const findResp = {
      ok: true,
      candidates: [
        { ref: "e11", selectorHint: 'getByRole("link",{name:"Docs"})', role: "link", score: 0.8 },
      ],
    };
    const handlers = { find: jsonHandler(findResp) };
    const report = await runFlakeCheck([{ tool: "find", args: { query: "docs" } }], {
      n: 2,
      allowed: ALLOWED,
      handlers,
    });
    const cache = report.cachedResolvers[0]!;
    expect(cache.ref).toBe("e11");
    expect(cache.selectorHint).toBe('getByRole("link",{name:"Docs"})');
    expect(cache.descriptor).toBeUndefined();
  });
});

describe("runFlakeCheck — internals (pure helpers)", () => {
  it("signatureFor extracts plan ref+hint when present", () => {
    const sig = signatureFor(
      { tool: "plan" },
      {
        tool: "plan",
        ok: true,
        result: { descriptor: { ref: "e1", evidence: { selectorHint: "role=button" } } },
      },
    );
    expect(sig).toBe("plan:e1::role=button");
  });

  it("signatureFor falls back to bound target when no resolution payload", () => {
    const sig = signatureFor(
      { tool: "click", args: { ref: "e9" } },
      { tool: "click", ok: true, result: { ok: true } },
    );
    expect(sig).toBe("ref:e9");
  });

  it("signatureFor distinguishes selector vs named targets", () => {
    expect(
      signatureFor({ tool: "click", args: { selector: "#save" } }, { tool: "click", ok: true }),
    ).toBe("selector:#save");
    expect(
      signatureFor({ tool: "click", args: { named: "save-btn" } }, { tool: "click", ok: true }),
    ).toBe("named:save-btn");
  });

  it("rollUpSteps caps distinct errors per step", () => {
    const calls = [{ tool: "click" }];
    const runs = Array.from({ length: 12 }, (_, i) => ({
      completed: 1,
      failedAt: 0,
      results: [{ tool: "click", ok: false, error: `err-${i}` }],
    }));
    const steps = rollUpSteps(calls, runs);
    expect(steps[0]!.errors.length).toBeLessThanOrEqual(8);
    expect(steps[0]!.runs).toBe(12);
    expect(steps[0]!.ok).toBe(0);
  });

  it("rollUpSteps reports successRate=null for a step no run reached", async () => {
    // Without stopOnError, runBatch reaches every step — to leave a step
    // unreached we feed a synthetic report with a short results array.
    const calls = [{ tool: "navigate" }, { tool: "click" }];
    const runs = [
      { completed: 1, failedAt: 0, results: [{ tool: "navigate", ok: false, error: "x" }] },
    ];
    const steps = rollUpSteps(calls, runs);
    expect(steps[1]!.runs).toBe(0);
    expect(steps[1]!.successRate).toBeNull();
  });

  it("extractCachedResolvers skips steps with no extractable target info", () => {
    // A coords-mode click — no ref/selector/named/query to cache.
    const calls = [{ tool: "click", args: { coords: { x: 10, y: 20 } } }];
    const runs = [
      {
        completed: 1,
        failedAt: null,
        results: [{ tool: "click", ok: true, result: { ok: true } }],
      },
      {
        completed: 1,
        failedAt: null,
        results: [{ tool: "click", ok: true, result: { ok: true } }],
      },
    ];
    const steps = rollUpSteps(calls, runs);
    const resolvers = extractCachedResolvers(calls, runs, steps);
    expect(resolvers).toHaveLength(0);
  });
});

describe("runFlakeCheck — forces stopOnError:false inside each run", () => {
  it("a failure mid-sequence does NOT halt the inner run — variance is captured for later steps too", async () => {
    const click = scriptedHandler([
      { ok: false, error: "step-1 always fails" },
      { ok: false, error: "step-1 always fails" },
    ]);
    const fill = scriptedHandler([{ ok: true }, { ok: true }]);
    const report = await runFlakeCheck([{ tool: "click" }, { tool: "fill" }], {
      n: 2,
      allowed: ALLOWED,
      handlers: { click, fill },
      stopOnError: true /* should be ignored */,
    });
    // Both steps should have run in BOTH runs despite the early failure.
    expect(report.steps[0]!.runs).toBe(2);
    expect(report.steps[1]!.runs).toBe(2);
    expect(report.steps[1]!.ok).toBe(2);
  });

  it("integration smoke — composes cleanly with runBatch's handler dispatch", async () => {
    // Sanity: the same handler set works in isolation under runBatch.
    const r = await runBatch([{ tool: "navigate" }], {
      allowed: ALLOWED,
      handlers: { navigate: jsonHandler({ ok: true }) },
    });
    expect(r.results[0]!.ok).toBe(true);
  });
});
