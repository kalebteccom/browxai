import { describe, it, expect } from "vitest";
import { Recorder } from "./recording.js";

describe("Recorder", () => {
  it("captures action types, urls, and selectorHints into a YAML draft", () => {
    const r = new Recorder();
    r.start("login-and-search");
    r.record(
      { type: "navigate", url: "https://app.example.com/login" },
      "https://app.example.com/login",
    );
    r.record({ type: "fill", ref: "e42", value: "alice" }, "https://app.example.com/login", {
      selectorHint: '[data-testid="username"]',
      stability: "high",
    });
    r.record({ type: "click", ref: "e43" }, "https://app.example.com/", {
      selectorHint: 'role=button[name="Submit"]',
      stability: "medium",
    });
    const { yaml, stepCount, name } = r.end();
    expect(name).toBe("login-and-search");
    expect(stepCount).toBe(3);
    expect(yaml).toContain("name: login-and-search");
    expect(yaml).toContain("locators:");
    expect(yaml).toContain('username: "[data-testid=\\"username\\"]"');
    expect(yaml).toContain('button_submit: "role=button[name=\\"Submit\\"]"');
    expect(yaml).toContain("action: navigate");
    expect(yaml).toContain("action: fill");
    expect(yaml).toContain("action: click");
    expect(yaml).toContain("target: $username");
    expect(yaml).toContain("target: $button_submit");
  });

  it("annotates the most recent step by default", () => {
    const r = new Recorder();
    r.start("smoke");
    r.record({ type: "navigate", url: "https://a.example.com" }, "https://a.example.com");
    r.record({ type: "click", ref: "e1" }, "https://a.example.com", {
      selectorHint: '[data-testid="x"]',
    });
    expect(r.annotate({ copy: "this clicks", arrow: "top" })).toEqual({ ok: true });
    const { yaml } = r.end();
    expect(yaml).toContain("annotation:");
    expect(yaml).toContain('copy: "this clicks"');
    expect(yaml).toContain("arrow: top");
  });

  it("rejects annotate when there's no active recording", () => {
    const r = new Recorder();
    expect(r.annotate({ copy: "nope" })).toEqual({ ok: false, error: "no active recording" });
  });

  it("rejects end when nothing's been started", () => {
    const r = new Recorder();
    expect(() => r.end()).toThrow(/no active recording/);
  });

  it("records read tools as their own step kind", () => {
    const r = new Recorder();
    r.start("read-thread");
    r.recordRead({ type: "snapshot", scope: "e4" }, "https://m.example.com/t/1");
    r.recordRead({ type: "find", query: "the reply button" }, "https://m.example.com/t/1", {
      selectorHint: 'role=button[name="Reply"]',
      stability: "medium",
    });
    r.recordRead(
      {
        type: "extract",
        schema: { type: "object", properties: { sender: { type: "string" } } },
        scope: "e12",
      },
      "https://m.example.com/t/1",
    );
    r.recordRead({ type: "eval_js", expr: "document.title" }, "https://m.example.com/t/1");

    const snap = r.inspect();
    expect(snap!.steps.map((s) => s.kind)).toEqual(["read", "read", "read", "read"]);
    expect(snap!.steps.map((s) => s.id)).toEqual([
      "snapshot-1",
      "find-2",
      "extract-3",
      "eval_js-4",
    ]);

    const { yaml, stepCount } = r.end();
    expect(stepCount).toBe(4);
    expect(yaml).toContain("read: snapshot");
    expect(yaml).toContain("read: find");
    expect(yaml).toContain('query: "the reply button"');
    expect(yaml).toContain("read: extract");
    expect(yaml).toContain('schema: {"type":"object","properties":{"sender":{"type":"string"}}}');
    expect(yaml).toContain('scope: "e12"');
    expect(yaml).toContain("read: eval_js");
    expect(yaml).toMatch(/expr: "document\.title" +# requires the `eval` capability/);
    // The locator a `find` resolved is a named locator like any action target.
    expect(yaml).toContain('button_reply: "role=button[name=\\"Reply\\"]"');
    expect(yaml).toContain("target: $button_reply");
  });

  it("ignores reads when no recording is active", () => {
    const r = new Recorder();
    r.recordRead({ type: "find", query: "anything" }, "https://a.example.com");
    expect(r.inspect()).toBeNull();
  });

  it("annotates a read step", () => {
    const r = new Recorder();
    r.start("read-thread");
    r.recordRead({ type: "extract", schema: { type: "object" } }, "https://a.example.com");
    expect(r.annotate({ copy: "the sender lands here" })).toEqual({ ok: true });
    expect(r.end().yaml).toContain('copy: "the sender lands here"');
  });

  it("flags medium/low stability with a review comment", () => {
    const r = new Recorder();
    r.start("smoke");
    r.record({ type: "click", ref: "e1" }, "u", {
      selectorHint: 'role=button[name="X"]',
      stability: "medium",
    });
    r.record({ type: "click", ref: "e2" }, "u", { selectorHint: "role=button", stability: "low" });
    const { yaml } = r.end();
    expect(yaml).toMatch(/stability: medium — review/);
    expect(yaml).toMatch(/stability: low — review/);
  });
});
