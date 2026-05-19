import { describe, it, expect } from "vitest";
import { Recorder } from "./recording.js";

describe("Recorder", () => {
  it("captures action types, urls, and selectorHints into a YAML draft", () => {
    const r = new Recorder();
    r.start("login-and-search");
    r.record({ type: "navigate", url: "https://app.example.com/login" }, "https://app.example.com/login");
    r.record(
      { type: "fill", ref: "e42", value: "alice" },
      "https://app.example.com/login",
      { selectorHint: '[data-testid="username"]', stability: "high" },
    );
    r.record(
      { type: "click", ref: "e43" },
      "https://app.example.com/",
      { selectorHint: 'role=button[name="Submit"]', stability: "medium" },
    );
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
    r.record({ type: "click", ref: "e1" }, "https://a.example.com", { selectorHint: '[data-testid="x"]' });
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

  it("flags medium/low stability with a review comment", () => {
    const r = new Recorder();
    r.start("smoke");
    r.record({ type: "click", ref: "e1" }, "u", { selectorHint: 'role=button[name="X"]', stability: "medium" });
    r.record({ type: "click", ref: "e2" }, "u", { selectorHint: "role=button", stability: "low" });
    const { yaml } = r.end();
    expect(yaml).toMatch(/stability: medium — review/);
    expect(yaml).toMatch(/stability: low — review/);
  });
});
