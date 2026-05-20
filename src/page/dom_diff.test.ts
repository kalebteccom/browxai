import { describe, it, expect } from "vitest";
import { diffDomMaps, type DomMap } from "./dom_diff.js";

const node = (over: Partial<DomMap[string]> = {}): DomMap[string] => ({
  tag: "div", classes: "", style: "", attrs: {}, ...over,
});

describe("diffDomMaps", () => {
  it("detects a class change as added/removed tokens", () => {
    const before: DomMap = { "0/1": node({ tag: "li", classes: "row" }) };
    const after: DomMap = { "0/1": node({ tag: "li", classes: "row selected" }) };
    const d = diffDomMaps(before, after);
    expect(d.counts).toEqual({ changed: 1, added: 0, removed: 0 });
    expect(d.changed[0]!.classDelta).toEqual({ added: ["selected"], removed: [] });
  });

  it("detects aria-* / data-* attribute changes", () => {
    const before: DomMap = { "0": node({ attrs: { "aria-selected": "false" } }) };
    const after: DomMap = { "0": node({ attrs: { "aria-selected": "true", "data-active": "1" } }) };
    const d = diffDomMaps(before, after);
    expect(d.changed[0]!.attrDelta).toEqual({
      "aria-selected": { before: "false", after: "true" },
      "data-active": { before: undefined, after: "1" },
    });
  });

  it("detects inline-style changes", () => {
    const before: DomMap = { "0": node({ style: "border:1px" }) };
    const after: DomMap = { "0": node({ style: "border:2px solid red" }) };
    expect(diffDomMaps(before, after).changed[0]!.styleDelta).toEqual({
      before: "border:1px", after: "border:2px solid red",
    });
  });

  it("reports added and removed elements", () => {
    const before: DomMap = { "0": node(), "0/0": node({ tag: "span", testId: "old" }) };
    const after: DomMap = { "0": node(), "0/1": node({ tag: "b", testId: "new" }) };
    const d = diffDomMaps(before, after);
    expect(d.removed).toEqual([{ path: "0/0", tag: "span", testId: "old" }]);
    expect(d.added).toEqual([{ path: "0/1", tag: "b", testId: "new" }]);
  });

  it("an unchanged map yields an empty diff", () => {
    const m: DomMap = { "0": node({ classes: "x", attrs: { "data-k": "v" } }) };
    expect(diffDomMaps(m, { ...m })).toMatchObject({ counts: { changed: 0, added: 0, removed: 0 } });
  });

  it("a null scope (didn't resolve) returns a note, not a throw", () => {
    const d = diffDomMaps(null, { "0": node() });
    expect(d.counts).toEqual({ changed: 0, added: 0, removed: 0 });
    expect(d.note).toMatch(/scope did not resolve/);
  });
});
