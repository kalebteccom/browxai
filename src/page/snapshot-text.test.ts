import { describe, it, expect } from "vitest";
import { serialise } from "./snapshot.js";
import { canCarryText, clipText, ownText, MAX_ROW_TEXT } from "./snapshot-text.js";
import type { A11yNode } from "./a11y.js";
import { SecretRegistry } from "../util/secrets.js";

function node(
  role: string,
  name: string | undefined,
  ref: string,
  children: A11yNode[] = [],
  extra: Partial<A11yNode> = {},
): A11yNode {
  return { ref, role, name, children, ...extra };
}

const text = (s: string, ref = "t"): A11yNode => node("StaticText", s, ref);
const doc = (...children: A11yNode[]): A11yNode => node("RootWebArea", "Page", "e1", children);

describe("serialise carried text", () => {
  it("puts a paragraph's words on its row", () => {
    const out = serialise(doc(node("paragraph", undefined, "e2", [text("Hello  world")])));
    expect(out).toContain('paragraph "Hello world" [ref=e2]');
  });

  it("reads through a text wrapper and keeps document order", () => {
    const p = node("paragraph", undefined, "e2", [
      text("a "),
      node("Abbr", undefined, "e3", [text("b")]),
      text(" c"),
    ]);
    expect(serialise(doc(p))).toContain('paragraph "a b c"');
  });

  it("does not repeat the text of a child that is its own row", () => {
    const p = node("paragraph", undefined, "e2", [
      text("See "),
      node("link", "docs", "e3", [text("docs")]),
    ]);
    const out = serialise(doc(p));
    expect(out).toContain('paragraph "See "');
    expect(out.match(/docs/g)).toHaveLength(1);
  });

  it("gives no text to a node that has a name", () => {
    const out = serialise(doc(node("group", "Named", "e2", [text("inner")])));
    expect(out).toContain('group "Named" [ref=e2]');
    expect(out).not.toContain("inner");
  });

  it("gives no text under a text field, so a password value stays off the row", () => {
    const field = node("textbox", undefined, "e2", [text("hunter2")]);
    const out = serialise(doc(field));
    expect(out).not.toContain("hunter2");
  });

  it("gives no text to a subtree under a text-owning role", () => {
    const btn = node("button", "Go", "e2", [node("paragraph", undefined, "e3", [text("Go")])]);
    const out = serialise(doc(btn));
    expect(out.match(/Go/g)).toHaveLength(1);
  });

  it("makes a StaticText directly under the document root a row", () => {
    expect(serialise(doc(text("loose words")))).toContain('StaticText "loose words"');
  });

  it("emits nothing for a StaticText under a container", () => {
    const out = serialise(doc(node("paragraph", undefined, "e2", [text("x", "e3")])));
    expect(out).not.toContain("StaticText");
  });

  it("clips a row to maxTextLen with an ellipsis", () => {
    const out = serialise(doc(node("paragraph", undefined, "e2", [text("x".repeat(500))])));
    expect(out).toContain(`"${"x".repeat(MAX_ROW_TEXT - 1)}…"`);
    expect(
      serialise(doc(node("paragraph", undefined, "e2", [text("abcdef")])), { maxTextLen: 4 }),
    ).toContain('"abc…"');
  });

  it("leaves rows bare past the budget and says how many", () => {
    const rows = [1, 2, 3, 4].map((i) =>
      node("paragraph", undefined, `e${i + 1}`, [text("12345678")]),
    );
    const out = serialise(doc(...rows), { textBudget: 16 });
    expect(out).toContain('paragraph "12345678" [ref=e2]');
    expect(out).toContain('paragraph "12345678" [ref=e3]');
    expect(out).toContain("paragraph [ref=e4]");
    expect(out).toContain("paragraph [ref=e5]");
    expect(out).toContain("text left off 2 row(s) past the 16 character text budget");
  });

  it("carries no text when pruneGeneric is off", () => {
    const out = serialise(doc(node("paragraph", undefined, "e2", [text("hi")])), {
      pruneGeneric: false,
    });
    expect(out).not.toContain('paragraph "hi"');
  });
});

describe("snapshot-text helpers", () => {
  it("canCarryText refuses named nodes, inputs, none and the document root", () => {
    expect(canCarryText({ role: "paragraph" })).toBe(true);
    expect(canCarryText({ role: "paragraph", name: "n" })).toBe(false);
    expect(canCarryText({ role: "textbox" })).toBe(false);
    expect(canCarryText({ role: "none" })).toBe(false);
    expect(canCarryText({ role: "RootWebArea" })).toBe(false);
    expect(canCarryText({ role: "LayoutTableCell" })).toBe(true);
  });

  it("ownText skips a StaticText that has a test id and stops near the limit", () => {
    const n = node("paragraph", undefined, "e2", [
      node("StaticText", "skip", "t1", [], { testId: "x" }),
      text("keep"),
    ]);
    expect(ownText(n)).toBe("keep");
    const long = node(
      "paragraph",
      undefined,
      "e3",
      Array.from({ length: 50 }, () => text("word ")),
    );
    expect(ownText(long, 20).length).toBeLessThan(40);
  });

  it("clipText leaves short text alone", () => {
    expect(clipText("abc", 3)).toBe("abc");
    expect(clipText("abcd", 3)).toBe("ab…");
  });
});

describe("serialise masks before clipping", () => {
  const SECRET = "SuperSecretToken123";
  const registry = new SecretRegistry();
  registry.register({ name: "TOKEN", value: SECRET });
  const maskText = (t: string): string => registry.applyMaskInText(t);

  it("masks a secret that straddles the row cap", () => {
    const words = "x".repeat(110) + SECRET;
    const out = serialise(doc(node("paragraph", undefined, "e2", [text(words)])), { maskText });
    expect(out).toContain("<TOKEN>");
    expect(out).not.toContain("Supe");
  });

  it("masks a secret that straddles the end of the text budget", () => {
    const words = "x".repeat(100) + SECRET;
    const out = serialise(doc(node("paragraph", undefined, "e2", [text(words)])), {
      maskText,
      textBudget: 110,
    });
    expect(out).not.toContain("Supe");
  });

  it("masks a secret that straddles the name cut", () => {
    const out = serialise(doc(node("button", "a".repeat(75) + SECRET, "e2")), { maskText });
    expect(out).not.toContain("Supe");
  });

  it("leaves text alone without a mask", () => {
    const out = serialise(doc(node("paragraph", undefined, "e2", [text(`id ${SECRET}`)])));
    expect(out).toContain(SECRET);
  });
});
