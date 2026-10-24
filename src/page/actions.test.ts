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

  it("omits valueRequested, displayText and checked when nothing supplied them", async () => {
    const loc = locator({
      inputValue: "hi",
      evaluateReturns: [false, undefined, null],
    });
    const r = await probe(loc, { ref: "e2" });
    expect(r.valueRequested).toBeUndefined();
    expect(r.displayText).toBeUndefined();
    expect(r.checked).toBeUndefined();
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

  it("surfaces checked:true for a ticked checkbox", async () => {
    const loc = locator({
      inputValue: "on",
      evaluateReturns: [false, true, null],
    });
    const r = await probe(loc, { ref: "e7" });
    expect(r.checked).toBe(true);
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
  const tgt = { ref: "e1" };
  const coords = { coords: { x: 10, y: 20 } };
  it.each([
    { name: "window scroll when no target and `to` given", args: { to: "bottom" }, kind: "window" },
    {
      name: "window scroll when no target and `by` given",
      args: { by: { y: 400 } },
      kind: "window",
    },
    {
      name: "into-view when a target is given and neither to nor by",
      args: { target: tgt },
      kind: "into-view",
    },
    {
      name: "container scroll when a target is given with `to`",
      args: { target: tgt, to: "bottom" },
      kind: "container",
    },
    {
      name: "container scroll when a target is given with `by`",
      args: { target: tgt, by: { y: 200 } },
      kind: "container",
    },
    {
      name: "intoView:false forces container even without to/by",
      args: { target: tgt, intoView: false },
      kind: "container",
    },
    { name: "coords target is wheel-at", args: { target: coords }, kind: "wheel-at" },
    {
      name: "coords target is wheel-at regardless of by",
      args: { target: coords, by: { y: 300 } },
      kind: "wheel-at",
    },
  ])("scrollMode: $name", ({ args, kind }) => {
    expect(scrollMode(args as Parameters<typeof scrollMode>[0]).kind).toBe(kind);
  });

  it("throws a clear no-op error when nothing is specified", () => {
    expect(() => scrollMode({})).toThrow(/no-op/);
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
