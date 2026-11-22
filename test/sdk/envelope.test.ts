// `unwrapResult` is the one rule every SDK method resolves by. Pure function,
// no server, no browser: each case feeds it an MCP content array and checks the
// value an SDK method would resolve to.

import { describe, it, expect } from "vitest";
import { parseEnvelope, unwrapResult } from "../../src/sdk/envelope.js";
import type { BrowxaiContentItem } from "../../src/sdk/types.js";

const text = (t: string): BrowxaiContentItem => ({ type: "text", text: t });
const image: BrowxaiContentItem = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

describe("unwrapResult: one text item", () => {
  it("a JSON object comes back parsed, with no wrapper around it", () => {
    const body = { ok: true, data: { title: "Example Domain" }, evidence: {}, warnings: [] };
    const r = unwrapResult([text(JSON.stringify(body, null, 2))]);
    expect(r).toEqual(body);
    expect(r).not.toHaveProperty("content");
  });

  it("an extract result reads as result.data.title, not result.data.data.title", () => {
    const r = unwrapResult([
      text(JSON.stringify({ ok: true, data: { title: "Example Domain" }, evidence: {} })),
    ]) as { ok: boolean; data: { title: string } };
    expect(r.data.title).toBe("Example Domain");
  });

  it("a failure object stays at the top level", () => {
    const body = { ok: false, failure: { source: "app", kind: "missing" } };
    expect(unwrapResult([text(JSON.stringify(body))])).toEqual(body);
  });

  it("a JSON array comes back as an array (console_read)", () => {
    const rows = [{ ts: 1, type: "log", text: "hi" }];
    expect(unwrapResult([text(JSON.stringify(rows))])).toEqual(rows);
  });

  it("an empty JSON array and an empty object are results, not missing values", () => {
    expect(unwrapResult([text("[]")])).toEqual([]);
    expect(unwrapResult([text("{}")])).toEqual({});
  });

  it("plain text comes back as the string (a snapshot tree, a server error message)", () => {
    const tree = "url: https://example.com/\ntitle: Example\n\n- heading [ref=e1]";
    expect(unwrapResult([text(tree)])).toBe(tree);
    expect(unwrapResult([text("some tool failed")])).toBe("some tool failed");
  });

  it("text that parses to a bare scalar stays a string", () => {
    expect(unwrapResult([text("42")])).toBe("42");
    expect(unwrapResult([text("true")])).toBe("true");
    expect(unwrapResult([text("null")])).toBe("null");
  });

  it("an empty text item is the empty string", () => {
    expect(unwrapResult([text("")])).toBe("");
  });
});

describe("unwrapResult: a result one value cannot hold keeps the envelope", () => {
  it("an inline screenshot (image item) returns { content, data? } as before", () => {
    const content = [image];
    const r = unwrapResult(content) as { content: unknown; data?: unknown };
    expect(r.content).toBe(content);
    expect(r.data).toBeUndefined();
  });

  it("an image with a plain-text caption keeps both items and has no data", () => {
    const content = [text('button "Save" bbox=1,2 3x4'), image];
    const r = unwrapResult(content) as { content: unknown[]; data?: unknown };
    expect(r.content).toHaveLength(2);
    expect(r.data).toBeUndefined();
  });

  it("an image result whose first text item is a JSON object still surfaces it as data", () => {
    // screenshot_marks: a JSON text item, then the image.
    const marks = { marks: [{ id: 1 }], mapping: {}, warnings: [] };
    const r = unwrapResult([text(JSON.stringify(marks)), image]) as {
      content: unknown[];
      data?: unknown;
    };
    expect(r.content).toHaveLength(2);
    expect(r.data).toEqual(marks);
  });

  it("several text items return the envelope so the later items are reachable", () => {
    const content = [text("warning: heads up"), text(JSON.stringify({ ok: true }))];
    const r = unwrapResult(content) as { content: unknown[]; data?: unknown };
    expect(r.content).toHaveLength(2);
    expect(r.data).toBeUndefined();
  });

  it("no content items returns an envelope with an empty content array", () => {
    expect(unwrapResult([])).toEqual({ content: [] });
  });

  it("matches parseEnvelope exactly for every enveloped case", () => {
    const cases: BrowxaiContentItem[][] = [
      [image],
      [text('{"a":1}'), image],
      [text("a"), text("b")],
      [],
    ];
    for (const content of cases) expect(unwrapResult(content)).toEqual(parseEnvelope(content));
  });
});
