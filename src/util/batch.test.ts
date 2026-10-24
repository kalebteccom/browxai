import { describe, it, expect } from "vitest";
import { runBatch, evaluateExpect, type ToolHandler } from "./batch.js";

const ALLOWED = new Set(["click", "fill", "navigate", "snapshot", "wait_for"]);

function jsonHandler(body: object): ToolHandler {
  return async () => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
}

const plainHandler: ToolHandler = async () => ({
  content: [{ type: "text", text: "plain reply" }],
});

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

  it.each([
    [
      "rejects a non-whitelisted tool with a clear error and stops",
      [{ tool: "click" }, { tool: "batch" }, { tool: "wait_for" }],
      { click: jsonHandler({ ok: true }), wait_for: jsonHandler({ ok: true }) },
      1,
      "not allowed inside batch",
    ],
    [
      "captures thrown errors from inner handlers as failed entries",
      [{ tool: "click" }],
      { click: throwingHandler("clicked into the void") },
      0,
      "clicked into the void",
    ],
    [
      "flags missing handler entries as failures",
      [{ tool: "click" }],
      {},
      0,
      'unknown tool "click"',
    ],
  ])("%s", async (_label, calls, handlers, failedAt, error) => {
    const report = await runBatch(calls, { allowed: ALLOWED, handlers });
    expect(report.failedAt).toBe(failedAt);
    expect(report.results[failedAt]?.ok).toBe(false);
    expect(report.results[failedAt]?.error).toContain(error);
    expect(report.results[failedAt + 1]).toBeUndefined();
  });

  it.each([
    [
      "parses inner JSON body; ok defaults to true when handler omits it",
      jsonHandler({ message: "no ok field here" }),
      { message: "no ok field here" },
    ],
    [
      "falls back to raw text when the handler's first content item isn't JSON",
      plainHandler,
      "plain reply",
    ],
  ])("%s", async (_label, handler, result) => {
    const report = await runBatch([{ tool: "click" }], {
      allowed: ALLOWED,
      handlers: { click: handler },
    });
    expect(report.results[0]?.ok).toBe(true);
    expect(report.results[0]?.result).toEqual(result);
  });
});

describe("runBatch — labels + expect", () => {
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

  it.each([
    [
      "handles missing element gracefully",
      { valueEquals: "x" },
      { something: "else" },
      /element.value/,
    ],
    [
      "ownerControl.changed predicate reads from element.ownerControl",
      { controlChanged: true },
      { element: { ownerControl: { changed: false } } },
      /ownerControl.changed/,
    ],
  ])("evaluateExpect: %s", (_label, expectArg, body, message) => {
    expect(evaluateExpect(expectArg, body)).toMatch(message);
  });
});
