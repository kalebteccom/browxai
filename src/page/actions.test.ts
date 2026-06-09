import { describe, it, expect } from "vitest";
import { probe, preProbe, scrollMode, waitFor, type PreProbeData } from "./actions.js";

// Minimal per-call mock. The `probe()` helper calls in order:
//   1. count()
//   2. inputValue()  (throws if elem isn't an input/textarea/select)
//   3. evaluate(focused?)   — boolean
//   4. evaluate(contentEditableText)  — string|null  [only if inputValue threw]
//   5. evaluate(checkedState)         — boolean|"mixed"|undefined
//   6. evaluate(displayText)          — string|null
// We script the evaluate returns in order so each test is explicit.

interface MockSpec {
  count?: number;
  /** undefined → inputValue() throws (not a standard input). */
  inputValue?: string | null;
  evaluateReturns: unknown[];
}

function locator(spec: MockSpec) {
  const evals = [...spec.evaluateReturns];
  return {
    count: async () => spec.count ?? 1,
    inputValue: async () => {
      if (spec.inputValue === undefined) throw new Error("not an input");
      return spec.inputValue;
    },
    evaluate: async () => {
      if (evals.length === 0)
        throw new Error("test mock: evaluate called more times than scripted");
      return evals.shift();
    },
  } as never;
}

describe("probe() — post-action element observability", () => {
  it("reads the DOM value back, not the requested echo", async () => {
    // Masked input rejected the trailing digits; agent must see the actual DOM value.
    const loc = locator({
      inputValue: "(555) 123",
      evaluateReturns: [
        true, // focused
        undefined, // checked (not a checkbox)
        null, // displayText (no labelled wrapper)
      ],
    });
    const r = await probe(loc, { ref: "e7" }, "5551234567");
    expect(r.stillAttached).toBe(true);
    expect(r.value).toBe("(555) 123");
    expect(r.valueRequested).toBe("5551234567");
    expect(r.value === r.valueRequested).toBe(false);
  });

  it("omits valueRequested for clicks/hovers (no value passed in)", async () => {
    const loc = locator({
      inputValue: "hi",
      evaluateReturns: [false, undefined, null],
    });
    const r = await probe(loc, { ref: "e2" });
    expect(r.valueRequested).toBeUndefined();
    expect(r.value).toBe("hi");
  });

  it("reports stillAttached:false when the element vanished mid-action", async () => {
    const loc = locator({ count: 0, evaluateReturns: [] });
    const r = await probe(loc, { ref: "e3" });
    expect(r.stillAttached).toBe(false);
  });

  it("falls back to contenteditable textContent for non-standard inputs", async () => {
    const loc = locator({
      inputValue: undefined, // throws
      evaluateReturns: [
        false, // focused
        "drafted text", // contenteditable textContent
        undefined, // checked
        null, // displayText
      ],
    });
    const r = await probe(loc, { ref: "e4" });
    expect(r.value).toBe("drafted text");
  });

  it("surfaces displayText for controls that render state outside input.value", async () => {
    // Pattern: control clears the underlying input on commit and renders the
    // committed selection in a labelled wrapper above (chip-style selects,
    // combobox displays, badge pickers, custom dropdowns).
    const loc = locator({
      inputValue: "",
      evaluateReturns: [
        true, // focused (search input still focused)
        undefined, // checked
        "Selected option", // displayText from labelled wrapper
      ],
    });
    const r = await probe(loc, { ref: "e5" }, "selected option");
    expect(r.value).toBe("");
    expect(r.displayText).toBe("Selected option");
    expect(r.valueRequested).toBe("selected option");
  });

  it("omits displayText when no labelled wrapper is found", async () => {
    const loc = locator({
      inputValue: "free text",
      evaluateReturns: [false, undefined, null],
    });
    const r = await probe(loc, { ref: "e6" });
    expect(r.displayText).toBeUndefined();
  });

  it("surfaces checked:true for a ticked checkbox", async () => {
    const loc = locator({
      inputValue: "on",
      evaluateReturns: [false, true, null],
    });
    const r = await probe(loc, { ref: "e7" });
    expect(r.checked).toBe(true);
  });

  it('surfaces checked:"mixed" for an indeterminate checkbox', async () => {
    const loc = locator({
      inputValue: "on",
      evaluateReturns: [false, "mixed", null],
    });
    const r = await probe(loc, { ref: "e8" });
    expect(r.checked).toBe("mixed");
  });

  it("omits checked for non-checkbox elements", async () => {
    const loc = locator({
      inputValue: "free text",
      evaluateReturns: [false, undefined, null],
    });
    const r = await probe(loc, { ref: "e9" });
    expect(r.checked).toBeUndefined();
  });
});

describe("probe() — ownerControl + container deltas", () => {
  it("composes ownerControl with changed=true when displayTextBefore ≠ displayTextAfter", async () => {
    const loc = locator({
      inputValue: "",
      evaluateReturns: [
        false, // focused
        undefined, // checked
        "Engineering", // displayText
        { ownerText: "Engineering", ownerLabel: "Type" }, // post ancestor probe
      ],
    });
    const pre: PreProbeData = { ownerText: "Enter Tag" };
    const r = await probe(loc, { ref: "e1" }, undefined, pre);
    expect(r.ownerControl).toBeDefined();
    expect(r.ownerControl?.changed).toBe(true);
    expect(r.ownerControl?.displayTextBefore).toBe("Enter Tag");
    expect(r.ownerControl?.displayTextAfter).toBe("Engineering");
    expect(r.ownerControl?.label).toBe("Type");
  });

  it("composes ownerControl with changed=false when displayText matches pre", async () => {
    const loc = locator({
      inputValue: "",
      evaluateReturns: [false, undefined, "Engineering", { ownerText: "Engineering" }],
    });
    const pre: PreProbeData = { ownerText: "Engineering" };
    const r = await probe(loc, { ref: "e2" }, undefined, pre);
    expect(r.ownerControl?.changed).toBe(false);
  });

  it("omits ownerControl when neither pre nor post has owner text", async () => {
    const loc = locator({
      inputValue: "free text",
      evaluateReturns: [false, undefined, null, {}],
    });
    const r = await probe(loc, { ref: "e3" });
    expect(r.ownerControl).toBeUndefined();
  });

  it("surfaces container probe from post-action ancestor walk", async () => {
    const loc = locator({
      inputValue: "",
      evaluateReturns: [
        false,
        undefined,
        null,
        {
          container: {
            kind: "row",
            rowKey: "Wed, May 13",
            rowText: "Wed, May 13 Engineering Reviewed PR",
          },
        },
      ],
    });
    const r = await probe(loc, { ref: "e4" });
    expect(r.container?.kind).toBe("row");
    expect(r.container?.rowKey).toBe("Wed, May 13");
    expect(r.container?.rowText).toContain("Engineering");
  });

  it("flags container.changed=true when pre and post rowText differ", async () => {
    const loc = locator({
      inputValue: "",
      evaluateReturns: [
        false,
        undefined,
        null,
        { container: { kind: "row", rowText: "row text after save" } },
      ],
    });
    const pre: PreProbeData = { container: { kind: "row", rowText: "row text before save" } };
    const r = await probe(loc, { ref: "e5" }, undefined, pre);
    expect(r.container?.changed).toBe(true);
  });

  it("flags container.changed=false when row text is stable", async () => {
    const loc = locator({
      inputValue: "",
      evaluateReturns: [
        false,
        undefined,
        null,
        { container: { kind: "row", rowText: "unchanged" } },
      ],
    });
    const pre: PreProbeData = { container: { kind: "row", rowText: "unchanged" } };
    const r = await probe(loc, { ref: "e6" }, undefined, pre);
    expect(r.container?.changed).toBe(false);
  });
});

describe("preProbe()", () => {
  it("returns the scripted ancestor probe result", async () => {
    const loc = locator({
      // preProbe only calls count() + evaluate(probeAncestors).
      evaluateReturns: [
        {
          ownerText: "Enter Tag",
          container: { kind: "row", rowText: "Wed, May 13" },
        },
      ],
    });
    const r = await preProbe(loc);
    expect(r.ownerText).toBe("Enter Tag");
    expect(r.container?.kind).toBe("row");
  });

  it("returns empty object when the locator resolves to nothing", async () => {
    const loc = locator({ count: 0, evaluateReturns: [] });
    const r = await preProbe(loc);
    expect(r).toEqual({});
  });
});

describe("scrollMode — scroll primitive dispatch", () => {
  it("window scroll when no target and to/by given", () => {
    expect(scrollMode({ to: "bottom" }).kind).toBe("window");
    expect(scrollMode({ by: { y: 400 } }).kind).toBe("window");
  });

  it("throws a clear no-op error when nothing is specified", () => {
    expect(() => scrollMode({})).toThrow(/no-op/);
  });

  it("into-view when a target is given and neither to nor by", () => {
    expect(scrollMode({ target: { ref: "e1" } }).kind).toBe("into-view");
  });

  it("container scroll when a target is given with to/by", () => {
    expect(scrollMode({ target: { ref: "e1" }, to: "bottom" }).kind).toBe("container");
    expect(scrollMode({ target: { ref: "e1" }, by: { y: 200 } }).kind).toBe("container");
  });

  it("intoView:false forces container even without to/by", () => {
    expect(scrollMode({ target: { ref: "e1" }, intoView: false }).kind).toBe("container");
  });

  it("intoView:true forces into-view even with to/by", () => {
    expect(scrollMode({ target: { ref: "e1" }, to: "bottom", intoView: true }).kind).toBe(
      "into-view",
    );
  });

  it("coords target → wheel-at regardless of to/by", () => {
    expect(scrollMode({ target: { coords: { x: 10, y: 20 } } }).kind).toBe("wheel-at");
    expect(scrollMode({ target: { coords: { x: 10, y: 20 } }, by: { y: 300 } }).kind).toBe(
      "wheel-at",
    );
  });
});

describe("waitFor — text predicate", () => {
  it("throws a clear error when neither target nor text is given", async () => {
    // Reaches the validation before touching page/cdp — minimal ctx is fine.
    const ctx = {
      page: {},
      cdp: {},
      refs: {},
      console: {},
      pages: () => [],
      testAttributes: [],
    } as never;
    await expect(waitFor(ctx, {})).rejects.toThrow(/pass a `target`.*or `text`/);
  });
});
