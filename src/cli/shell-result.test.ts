import { describe, expect, it } from "vitest";
import {
  base64Bytes,
  buildDocument,
  cutText,
  errorResult,
  EXIT,
  exitCodeFor,
  type ToolResult,
} from "./shell-result.js";

const text = (body: string, isError?: boolean): ToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError === undefined ? {} : { isError }),
});

describe("exit codes", () => {
  it("is 0 for a result with ok true, and for one with no ok field", () => {
    expect(exitCodeFor(false, { ok: true })).toBe(0);
    expect(exitCodeFor(false, { sessions: [] })).toBe(0);
    expect(exitCodeFor(false, undefined)).toBe(0);
    expect(exitCodeFor(false, [1, 2])).toBe(0);
  });

  it("is 1 for an error result, and for ok false", () => {
    expect(exitCodeFor(true, undefined)).toBe(1);
    expect(exitCodeFor(true, { ok: true })).toBe(1);
    expect(exitCodeFor(false, { ok: false, error: "no element" })).toBe(1);
  });

  it("is 4 for ok false with a requiredCapability field", () => {
    expect(exitCodeFor(false, { ok: false, requiredCapability: "eval" })).toBe(4);
    expect(exitCodeFor(false, { ok: false, requiredCapability: null })).toBe(4);
  });

  it("is 0 when a result only names a capability it could not use", () => {
    expect(
      exitCodeFor(false, { ok: true, bodyOmitted: true, requiredCapability: "network-body" }),
    ).toBe(0);
  });

  it("keeps the table of codes the docs state", () => {
    expect(EXIT).toEqual({ ok: 0, toolError: 1, usage: 2, unreachable: 3, refused: 4 });
  });
});

describe("buildDocument", () => {
  it("puts a JSON object in data and leaves text out", () => {
    const { doc, exitCode } = buildDocument(text('{"ok":true,"n":1}'), 40_000);
    expect(doc).toEqual({ isError: false, data: { ok: true, n: 1 }, images: [] });
    expect(exitCode).toBe(0);
  });

  it("puts a JSON array in data", () => {
    const { doc } = buildDocument(text('[{"a":1}]'), 40_000);
    expect(doc.data).toEqual([{ a: 1 }]);
    expect(doc.text).toBeUndefined();
  });

  it("puts text that is not a JSON object or array in text", () => {
    const tree = "- document [ref=e1]\n  - heading 'Hi' [ref=e2]";
    expect(buildDocument(text(tree), 40_000).doc).toEqual({
      isError: false,
      text: tree,
      images: [],
    });
    // A bare number or string parses as JSON but is not an object: it stays text.
    expect(buildDocument(text("42"), 40_000).doc.text).toBe("42");
    expect(buildDocument(text('"quoted"'), 40_000).doc.text).toBe('"quoted"');
  });

  it("reads the first text item only", () => {
    const res: ToolResult = {
      content: [
        { type: "text", text: '{"first":true}' },
        { type: "text", text: '{"second":true}' },
      ],
    };
    expect(buildDocument(res, 40_000).doc.data).toEqual({ first: true });
  });

  it("marks an error result and exits 1", () => {
    const built = buildDocument(text("boom", true), 40_000);
    expect(built.doc).toEqual({ isError: true, text: "boom", images: [] });
    expect(built.exitCode).toBe(1);
  });

  it("exits 4 for a gate refusal and keeps the refusal in data", () => {
    const refusal = {
      ok: false,
      error: 'tool "eval_js" is disabled: its capability "eval" is not enabled on this server',
      requiredCapability: "eval",
      hint: "Add the capability to `BROWX_CAPABILITIES` and restart the browxai server.",
    };
    const built = buildDocument(text(JSON.stringify(refusal, null, 2)), 40_000);
    expect(built.exitCode).toBe(4);
    expect(built.doc.data).toEqual(refusal);
  });

  it("lists images by type and byte length and never carries their pixels", () => {
    const data = Buffer.from("not really a png").toString("base64");
    const res: ToolResult = {
      content: [
        { type: "image", data, mimeType: "image/png" },
        { type: "text", text: '{"ok":true}' },
        { type: "image", data, mimeType: "image/jpeg" },
      ],
    };
    const built = buildDocument(res, 40_000);
    expect(built.doc.images).toEqual([
      { mimeType: "image/png", bytes: 16 },
      { mimeType: "image/jpeg", bytes: 16 },
    ]);
    expect(JSON.stringify(built.doc)).not.toContain(data);
    expect(built.firstImage).toEqual({ data, mimeType: "image/png" });
  });

  it("has no first image when the result carries none", () => {
    expect(buildDocument(text("{}"), 40_000).firstImage).toBeUndefined();
  });

  it("cuts a long text to the cap and records the length before the cut", () => {
    const long = "x".repeat(100);
    const { doc, exitCode } = buildDocument(text(long), 40);
    expect(doc.text).toBe("x".repeat(40));
    expect(doc.truncated).toEqual({ originalChars: 100, maxChars: 40 });
    expect(exitCode).toBe(0);
  });

  it("replaces data that is over the cap with the first characters of its JSON", () => {
    const body = { ok: true, rows: Array.from({ length: 50 }, (_, i) => `row-${i}`) };
    const json = JSON.stringify(body);
    const { doc } = buildDocument(text(JSON.stringify(body, null, 2)), 60);
    expect(doc.data).toBeUndefined();
    expect(doc.text).toBe(json.slice(0, 60));
    expect(doc.truncated).toEqual({ originalChars: json.length, maxChars: 60 });
  });

  it("reads the exit code from the whole result before the cut", () => {
    const refusal = { ok: false, requiredCapability: "eval", hint: "h".repeat(500) };
    const built = buildDocument(text(JSON.stringify(refusal)), 50);
    expect(built.doc.truncated).toBeDefined();
    expect(built.exitCode).toBe(4);
  });

  it("does not cut a payload that fits, and a cap of 0 cuts nothing", () => {
    const body = { rows: "y".repeat(1000) };
    expect(buildDocument(text(JSON.stringify(body)), 5000).doc.truncated).toBeUndefined();
    const all = buildDocument(text(JSON.stringify(body)), 0);
    expect(all.doc.truncated).toBeUndefined();
    expect(all.doc.data).toEqual(body);
  });

  it("copes with an empty result", () => {
    const built = buildDocument({ content: [] }, 40_000);
    expect(built.doc).toEqual({ isError: false, images: [] });
    expect(built.exitCode).toBe(0);
  });
});

describe("helpers", () => {
  it("counts the bytes behind a base64 string", () => {
    for (const raw of ["", "a", "ab", "abc", "abcd", "hello world"]) {
      expect(base64Bytes(Buffer.from(raw).toString("base64"))).toBe(raw.length);
    }
  });

  it("cuts without leaving half of a surrogate pair", () => {
    expect(cutText("ab\u{1f600}cd", 3)).toBe("ab");
    expect(cutText("ab\u{1f600}cd", 4)).toBe("ab\u{1f600}");
    expect(cutText("abc", 10)).toBe("abc");
  });

  it("builds an error result on the client", () => {
    expect(errorResult("MCP error -32603: bad")).toEqual({
      isError: true,
      content: [{ type: "text", text: "MCP error -32603: bad" }],
    });
  });
});
