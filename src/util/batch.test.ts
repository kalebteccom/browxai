import { describe, it, expect } from "vitest";
import { runBatch, evaluateExpect, type ToolHandler } from "./batch.js";

const ALLOWED = new Set(["click", "fill", "navigate", "snapshot", "wait_for"]);

function jsonHandler(body: object): ToolHandler {
  return async () => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
}

function throwingHandler(msg: string): ToolHandler {
  return async () => {
    throw new Error(msg);
  };
}

describe("runBatch — sequential dispatch", () => {
  it("runs each whitelisted call in order and returns one entry per call", async () => {
    const order: string[] = [];
    const trace = (label: string) => async () => {
      order.push(label);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, label }) }] };
    };
    const handlers = { click: trace("click"), fill: trace("fill"), wait_for: trace("wait") };
    const report = await runBatch(
      [
        { tool: "click", args: { ref: "e1" } },
        { tool: "fill", args: { ref: "e2", value: "x" } },
        { tool: "wait_for", args: { ref: "e3" } },
      ],
      { allowed: ALLOWED, handlers },
    );
    expect(order).toEqual(["click", "fill", "wait"]);
    expect(report.completed).toBe(3);
    expect(report.failedAt).toBeNull();
    expect(report.results.every((r) => r.ok)).toBe(true);
  });

  it("stops at the first failure by default (stopOnError defaults true)", async () => {
    const calls = [
      { tool: "click", args: {} },
      { tool: "fill", args: {} }, // will fail
      { tool: "wait_for", args: {} }, // should NOT run
    ];
    const handlers = {
      click: jsonHandler({ ok: true }),
      fill: jsonHandler({ ok: false, error: "element not found" }),
      wait_for: jsonHandler({ ok: true }),
    };
    const report = await runBatch(calls, { allowed: ALLOWED, handlers });
    expect(report.completed).toBe(2);
    expect(report.failedAt).toBe(1);
    expect(report.results[2]).toBeUndefined();
  });

  it("continues past failures when stopOnError=false; failedAt records first failure", async () => {
    const calls = [
      { tool: "click", args: {} },
      { tool: "fill", args: {} }, // fails
      { tool: "wait_for", args: {} }, // still runs
    ];
    const handlers = {
      click: jsonHandler({ ok: true }),
      fill: jsonHandler({ ok: false }),
      wait_for: jsonHandler({ ok: true }),
    };
    const report = await runBatch(calls, { allowed: ALLOWED, handlers, stopOnError: false });
    expect(report.completed).toBe(3);
    expect(report.failedAt).toBe(1);
    expect(report.results.map((r) => r.ok)).toEqual([true, false, true]);
  });

  it("rejects non-whitelisted tools with a clear error and stops", async () => {
    const calls = [
      { tool: "click", args: {} },
      { tool: "batch", args: {} }, // nesting blocked
      { tool: "wait_for", args: {} },
    ];
    const handlers = {
      click: jsonHandler({ ok: true }),
      wait_for: jsonHandler({ ok: true }),
    };
    const report = await runBatch(calls, { allowed: ALLOWED, handlers });
    expect(report.failedAt).toBe(1);
    expect(report.results[1]?.ok).toBe(false);
    expect(report.results[1]?.error).toContain("not allowed inside batch");
    expect(report.results[2]).toBeUndefined();
  });

  it("captures thrown errors from inner handlers as failed entries", async () => {
    const handlers = {
      click: throwingHandler("clicked into the void"),
    };
    const report = await runBatch([{ tool: "click" }], { allowed: ALLOWED, handlers });
    expect(report.failedAt).toBe(0);
    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.error).toContain("clicked into the void");
  });

  it("flags missing handler entries as failures", async () => {
    const report = await runBatch([{ tool: "click" }], { allowed: ALLOWED, handlers: {} });
    expect(report.failedAt).toBe(0);
    expect(report.results[0]?.error).toContain('unknown tool "click"');
  });

  it("parses inner JSON body; ok defaults to true when handler omits it", async () => {
    const report = await runBatch([{ tool: "click" }], {
      allowed: ALLOWED,
      handlers: { click: jsonHandler({ message: "no ok field here" }) },
    });
    expect(report.results[0]?.ok).toBe(true);
    expect(report.results[0]?.result).toEqual({ message: "no ok field here" });
  });

  it("falls back to raw text when the handler's first content item isn't JSON", async () => {
    const handler: ToolHandler = async () => ({ content: [{ type: "text", text: "plain reply" }] });
    const report = await runBatch([{ tool: "click" }], {
      allowed: ALLOWED,
      handlers: { click: handler },
    });
    expect(report.results[0]?.ok).toBe(true);
    expect(report.results[0]?.result).toBe("plain reply");
  });
});

describe("runBatch — labels + expect", () => {
  it("echoes the call's label on the result entry", async () => {
    const report = await runBatch([{ tool: "click", label: "set type", args: {} }], {
      allowed: ALLOWED,
      handlers: { click: jsonHandler({ ok: true }) },
    });
    expect(report.results[0]?.label).toBe("set type");
  });

  it("omits label on entries where the call didn't supply one", async () => {
    const report = await runBatch([{ tool: "click" }], {
      allowed: ALLOWED,
      handlers: { click: jsonHandler({ ok: true }) },
    });
    expect(report.results[0]?.label).toBeUndefined();
  });

  it("marks call ok=false when expect predicate fails", async () => {
    const handler = jsonHandler({ ok: true, element: { value: "actual" } });
    const report = await runBatch(
      [{ tool: "fill", args: {}, expect: { valueEquals: "expected" } }],
      { allowed: ALLOWED, handlers: { fill: handler } },
    );
    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.error).toContain("expect failed");
    expect(report.results[0]?.error).toContain('"expected"');
  });

  it("passes when expect predicate holds", async () => {
    const handler = jsonHandler({ ok: true, element: { value: "expected" } });
    const report = await runBatch(
      [{ tool: "fill", args: {}, expect: { valueEquals: "expected" } }],
      { allowed: ALLOWED, handlers: { fill: handler } },
    );
    expect(report.results[0]?.ok).toBe(true);
    expect(report.results[0]?.error).toBeUndefined();
  });

  it("respects stopOnError when an expect predicate fails", async () => {
    const ok = jsonHandler({ ok: true, element: { value: "good" } });
    const expecting = jsonHandler({ ok: true, element: { value: "actual" } });
    const report = await runBatch(
      [
        { tool: "fill", args: {}, label: "first" },
        { tool: "fill", args: {}, label: "second", expect: { valueEquals: "intended" } },
        { tool: "click", args: {}, label: "third" }, // should not run
      ],
      { allowed: ALLOWED, handlers: { fill: ok, click: expecting } },
    );
    expect(report.failedAt).toBe(1);
    expect(report.results.length).toBe(2);
  });
});

describe("evaluateExpect — predicate evaluation", () => {
  it("returns null when all predicates pass", () => {
    const body = {
      element: {
        value: "x",
        displayText: "hello world",
        ownerControl: { displayTextAfter: "Engineering", changed: true },
        container: { rowText: "row contents include hit" },
      },
    };
    expect(
      evaluateExpect(
        {
          valueEquals: "x",
          displayTextIncludes: "hello",
          controlDisplayTextIncludes: "Engineering",
          containerTextIncludes: "hit",
          controlChanged: true,
        },
        body,
      ),
    ).toBeNull();
  });

  it("returns a descriptive error when valueEquals fails", () => {
    expect(evaluateExpect({ valueEquals: "expected" }, { element: { value: "other" } })).toMatch(
      /element.value/,
    );
  });

  it("handles missing element gracefully", () => {
    expect(evaluateExpect({ valueEquals: "x" }, { something: "else" })).toMatch(/element.value/);
  });

  it("ownerControl.changed predicate reads from element.ownerControl", () => {
    expect(
      evaluateExpect({ controlChanged: true }, { element: { ownerControl: { changed: false } } }),
    ).toMatch(/ownerControl.changed/);
  });
});
