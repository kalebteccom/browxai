import { describe, it, expect } from "vitest";
import { probeAncestorsScript, type PreProbeData } from "./actions-probe.js";

// Playwright sends the probe's source text to the page, where nothing from this
// module exists. Rebuilding the function from that text with the Function
// constructor gives it the same global-only scope, so a reference to a
// module-level binding throws here as it would in the page.
function fromSource(): (el: unknown, slack: number) => PreProbeData {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function(`return (${probeAncestorsScript.toString()});`) as () => (
    el: unknown,
    slack: number,
  ) => PreProbeData;
  return build();
}

interface FakeEl {
  tagName: string;
  parentElement: FakeEl | null;
  innerText?: string;
  dataset?: Record<string, string>;
  getAttribute: (k: string) => string | null;
}

function el(
  tagName: string,
  parentElement: FakeEl | null,
  opts: {
    attrs?: Record<string, string>;
    innerText?: string;
    dataset?: Record<string, string>;
  } = {},
): FakeEl {
  return {
    tagName,
    parentElement,
    innerText: opts.innerText,
    dataset: opts.dataset ?? {},
    getAttribute: (k) => opts.attrs?.[k] ?? null,
  };
}

describe("probeAncestorsScript run from its source text", () => {
  it("reports a <tr> container for a table cell", () => {
    const body = el("BODY", null);
    const table = el("TABLE", body);
    const tr = el("TR", table, { innerText: "Alice\tAdmin" });
    const td = el("TD", tr, { innerText: "Admin" });
    const button = el("BUTTON", td);
    expect(fromSource()(button, 0)).toEqual({
      container: { kind: "tr", rowKey: "Alice\tAdmin", rowText: "Alice Admin" },
    });
  });

  it("reports a role=listitem container and a combobox owner", () => {
    const body = el("BODY", null);
    const owner = el("DIV", body, {
      attrs: { role: "combobox", "aria-label": "Team" },
      innerText: "Engineering",
    });
    const li = el("DIV", owner, { attrs: { role: "listitem" }, innerText: "Engineering\nlead" });
    const span = el("SPAN", li);
    expect(fromSource()(span, 0)).toEqual({
      ownerText: "Engineering",
      ownerLabel: "Team",
      container: { kind: "listitem", rowKey: "Engineering", rowText: "Engineering lead" },
    });
  });

  it("returns {} when no ancestor matches", () => {
    const body = el("BODY", null);
    const div = el("DIV", body, { innerText: "plain" });
    expect(fromSource()(el("SPAN", div), 0)).toEqual({});
  });
});
