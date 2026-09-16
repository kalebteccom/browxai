import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import { RefRegistry } from "./refs.js";
import { locatorFor, resolveTargetChecked } from "./locator.js";
import { PlaywrightElementSubstrate, SafariElementSubstrate } from "./element-substrate.js";

// The element port, both adapters, and the one behaviour RFC 0009 P2 is under
// orders NOT to change.
//
// THE MOCK MODELS `.first()` FAITHFULLY, and that is the point of this file. A
// Playwright `Locator` is itself a deferred query, and `.first()` returns a
// locator pinned to `nth=0` — so `.first().count()` is 0 or 1 whatever the
// selector matches. Verified against real Chromium in
// `test/keystone/element-substrate.keystone.test.ts`; the mock below reproduces
// it so the unit lane can assert the same thing.
//
// `src/page/locator.test.ts`'s `countingPage` does NOT model it: its `first()`
// returns a node whose `count()` still reads the per-selector table. That is why
// the two ambiguity cases in that file pass while the branch they exercise cannot
// be reached in production — see the last describe block here, which pins the
// shipped behaviour instead.

interface ElementBehaviour {
  /** How many nodes the SELECTOR matches, before any `.first()` narrowing. */
  matches?: number;
  isVisible?: boolean;
  isEnabled?: boolean;
  innerText?: string;
  attributes?: Record<string, string | null>;
  evaluated?: string | null;
  box?: { x: number; y: number; width: number; height: number } | null;
  /** Make the named read reject, to exercise the per-read failure paths. */
  throwOn?: "count" | "isVisible" | "isEnabled" | "boundingBox";
}

/** A locator over `sel`. `narrowed` is true once `.first()` has been applied, and
 *  it is what caps `count()` at one — exactly Playwright's `nth=0` semantics. */
function mockLocator(b: ElementBehaviour, narrowed: boolean): Locator {
  const self = {} as Locator;
  const matches = b.matches ?? 1;
  Object.assign(self, {
    first: () => mockLocator(b, true),
    count: async () => {
      if (b.throwOn === "count") throw new Error("count blew up");
      return narrowed ? Math.min(matches, 1) : matches;
    },
    isVisible: async () => {
      if (b.throwOn === "isVisible") throw new Error("isVisible blew up");
      return b.isVisible ?? true;
    },
    isEnabled: async () => {
      if (b.throwOn === "isEnabled") throw new Error("isEnabled blew up");
      return b.isEnabled ?? true;
    },
    innerText: async () => b.innerText ?? "",
    getAttribute: async (name: string) => b.attributes?.[name] ?? null,
    evaluate: async () => b.evaluated ?? "hidden",
    boundingBox: async () => {
      if (b.throwOn === "boundingBox") throw new Error("boundingBox blew up");
      return b.box === undefined ? { x: 1, y: 2, width: 30, height: 40 } : b.box;
    },
  });
  return self;
}

function mockPage(map: Record<string, ElementBehaviour>): Page {
  return {
    getByRole: (role: string, opts?: { name?: string }) =>
      mockLocator(map[`role:${role}${opts?.name ? `[name=${opts.name}]` : ""}`] ?? {}, false),
    locator: (selector: string) => mockLocator(map[selector] ?? {}, false),
  } as unknown as Page;
}

function elementsOver(page: Page, refs: RefRegistry): PlaywrightElementSubstrate {
  return new PlaywrightElementSubstrate(() => page, {} as never, refs, "chromium");
}

function testIdRef(refs: RefRegistry, id = "row-edit"): string {
  return refs.forKey(`k-${id}`, {
    role: "button",
    testId: id,
    testIdAttr: "data-testid",
    source: "dom",
  });
}

describe("PlaywrightElementSubstrate — resolve", () => {
  it("mints a token that carries the RECIPE, not a locator", async () => {
    const refs = new RefRegistry();
    const ref = testIdRef(refs);
    const res = await elementsOver(mockPage({}), refs).resolve({ kind: "ref", ref });
    expect(res.kind).toBe("element");
    if (res.kind !== "element") return;
    // The whole withdrawn-fallback question, asserted structurally: the token is
    // plain data that round-trips through JSON. A cached `Locator` could not.
    expect(JSON.parse(JSON.stringify(res.el))).toEqual({
      __brand: "element",
      query: { kind: "ref", ref },
    });
  });

  it("refuses `no-such-element` for a ref the registry never held", async () => {
    const res = await elementsOver(mockPage({}), new RefRegistry()).resolve({
      kind: "ref",
      ref: "e999",
    });
    expect(res.kind).toBe("refusal");
    if (res.kind !== "refusal") return;
    expect(res.reason).toBe("no-such-element");
    expect(res.ref).toBe("e999");
  });

  it("refuses `unaddressable-target` and carries the builder's own message", async () => {
    const refs = new RefRegistry();
    const res = await elementsOver(mockPage({}), refs).resolve({
      kind: "selector",
      selector: ".x",
      contextRef: "e404",
    });
    expect(res.kind).toBe("refusal");
    if (res.kind !== "refusal") return;
    expect(res.reason).toBe("unaddressable-target");
    expect(res.error).toContain("unknown contextRef");
  });

  it("does not touch the page's count — resolution costs no round trip", async () => {
    const refs = new RefRegistry();
    const ref = testIdRef(refs);
    const page = mockPage({ '[data-testid="row-edit"]': { throwOn: "count" } });
    // A `count()` that throws would surface if `resolve` called it.
    await expect(elementsOver(page, refs).resolve({ kind: "ref", ref })).resolves.toMatchObject({
      kind: "element",
    });
  });
});

describe("PlaywrightElementSubstrate — probe", () => {
  const refs = new RefRegistry();
  const ref = testIdRef(refs);
  const sel = '[data-testid="row-edit"]';

  async function probeWith(
    b: ElementBehaviour,
    want: Parameters<PlaywrightElementSubstrate["probe"]>[1],
  ): ReturnType<PlaywrightElementSubstrate["probe"]> {
    const elements = elementsOver(mockPage({ [sel]: b }), refs);
    const res = await elements.resolve({ kind: "ref", ref });
    if (res.kind !== "element") throw new Error("resolve refused");
    return elements.probe(res.el, want);
  }

  it("answers several questions in one call", async () => {
    const r = await probeWith(
      { isVisible: true, isEnabled: false, innerText: " Save ", attributes: { "aria-x": "1" } },
      { matches: true, visible: true, enabled: true, text: true, attribute: "aria-x" },
    );
    expect(r).toMatchObject({
      kind: "reading",
      matches: 1,
      visible: true,
      enabled: false,
      text: " Save ",
      attribute: "1",
    });
  });

  it("refuses `stale-element` when the recipe matches nothing", async () => {
    const r = await probeWith({ matches: 0 }, { matches: true, visible: true });
    expect(r).toMatchObject({ kind: "refusal", reason: "stale-element" });
  });

  it("only spends the second round trip on the not-visible reason when it has to", async () => {
    const hidden = await probeWith(
      { isVisible: false, evaluated: "hidden (display:none)" },
      { matches: true, visible: true, notVisibleReason: true },
    );
    expect(hidden).toMatchObject({ notVisibleReason: "hidden (display:none)" });
    const shown = await probeWith(
      { isVisible: true, evaluated: "should not be read" },
      { matches: true, visible: true, notVisibleReason: true },
    );
    expect(shown).not.toHaveProperty("notVisibleReason");
  });

  it("records a per-read failure instead of losing the other reads", async () => {
    // The shape `find`'s actionability probe depends on: it caught `isEnabled`
    // and `isVisible` independently and defaulted each to true. Refusing the whole
    // probe when one fails would throw away the other's answer.
    const r = await probeWith(
      { throwOn: "isEnabled", isVisible: false },
      {
        visible: true,
        enabled: true,
      },
    );
    expect(r).toMatchObject({ kind: "reading", visible: false });
    if (r.kind !== "reading") return;
    expect(r.enabled).toBeUndefined();
    expect(r.failures?.enabled).toContain("isEnabled blew up");
  });

  it("refuses `probe-failed` when the structural count itself fails", async () => {
    const r = await probeWith({ throwOn: "count" }, { matches: true, visible: true });
    expect(r).toMatchObject({ kind: "refusal", reason: "probe-failed" });
  });
});

describe("PlaywrightElementSubstrate — bounds and count", () => {
  it("reports a null box as an answer, not a refusal", async () => {
    const refs = new RefRegistry();
    const ref = testIdRef(refs);
    const elements = elementsOver(mockPage({ '[data-testid="row-edit"]': { box: null } }), refs);
    const res = await elements.resolve({ kind: "ref", ref });
    if (res.kind !== "element") throw new Error("resolve refused");
    expect(await elements.bounds(res.el)).toEqual({ kind: "bounds", rect: null });
  });

  it("reports a zero-sized box rather than flattening it to null", async () => {
    // Each caller's own zero-size policy stays at the caller: `find` drops it,
    // `targetPoint` refuses to aim at it, `describeTarget` prints `0×0`. Folding
    // the decision into the port would pick one of the three for all of them.
    const refs = new RefRegistry();
    const ref = testIdRef(refs);
    const elements = elementsOver(
      mockPage({ '[data-testid="row-edit"]': { box: { x: 0, y: 0, width: 0, height: 9 } } }),
      refs,
    );
    const res = await elements.resolve({ kind: "ref", ref });
    if (res.kind !== "element") throw new Error("resolve refused");
    expect(await elements.bounds(res.el)).toEqual({
      kind: "bounds",
      rect: { x: 0, y: 0, width: 0, height: 9 },
    });
  });

  it("surfaces a boundingBox throw as a refusal rather than swallowing it", async () => {
    // `gestures.targetPoint` re-throws this, which is how a caller still sees
    // Playwright's own timeout message. Swallowing it to `rect: null` would turn
    // a 30-second timeout into "no rendered box" — a different answer.
    const refs = new RefRegistry();
    const ref = testIdRef(refs);
    const elements = elementsOver(
      mockPage({ '[data-testid="row-edit"]': { throwOn: "boundingBox" } }),
      refs,
    );
    const res = await elements.resolve({ kind: "ref", ref });
    if (res.kind !== "element") throw new Error("resolve refused");
    expect(await elements.bounds(res.el)).toMatchObject({
      kind: "refusal",
      reason: "probe-failed",
    });
  });

  it("counts an `expression` query over the collection, a `ref` query after `.first()`", async () => {
    // The distinction `verify_count` depends on. Both queries name the same six
    // nodes; only the engine-native expression reports six, because `locatorFor`
    // narrows every ref tier to `.first()`.
    const refs = new RefRegistry();
    const ref = testIdRef(refs);
    const elements = elementsOver(mockPage({ '[data-testid="row-edit"]': { matches: 6 } }), refs);
    expect(
      await elements.count({ kind: "expression", expression: '[data-testid="row-edit"]' }),
    ).toEqual({ kind: "count", n: 6 });
    expect(await elements.count({ kind: "ref", ref })).toEqual({ kind: "count", n: 1 });
  });
});

describe("SafariElementSubstrate — refuses rather than answering emptily", () => {
  const safari = new SafariElementSubstrate();

  it("refuses all four members with `engine-unsupported`", async () => {
    const token = { __brand: "element", query: { kind: "ref", ref: "e1" } } as const;
    for (const outcome of [
      await safari.resolve(),
      await safari.bounds(),
      await safari.probe(),
      await safari.count(),
    ]) {
      expect(outcome).toMatchObject({ kind: "refusal", reason: "engine-unsupported" });
    }
    expect(token.__brand).toBe("element");
  });

  it("never returns a plausible empty answer", async () => {
    // The `SafariNoopNetworkSubstrate` defect, not repeated: that one answers
    // `{summary:{total:0}, requests:[]}` for a question safari cannot answer, and
    // an agent cannot tell it from a true negative.
    const counted = await safari.count();
    expect(counted).not.toMatchObject({ kind: "count" });
    const measured = await safari.bounds();
    expect(measured).not.toMatchObject({ kind: "bounds" });
  });
});

describe("web ambiguity resolves to the first match and is NOT refused", () => {
  // RFC 0009 §ElementSubstrate, amendment 2026-09-16. `resolve`'s doc comment says
  // zero-or-many matches is a refusal. On web that is not what ships, and P2 is
  // explicitly not the change that makes it so: turning the warning into a refusal
  // alters what a shipped tool does to a page. This block is the pin — a later
  // phase that flips web to refuse fails here and has to mean it.

  it("resolves an ambiguous ref instead of refusing", async () => {
    const refs = new RefRegistry();
    const ref = testIdRef(refs);
    const elements = elementsOver(mockPage({ '[data-testid="row-edit"]': { matches: 6 } }), refs);
    const res = await elements.resolve({ kind: "ref", ref });
    expect(res.kind, "P2 must not refuse a multi-match ref on web").toBe("element");
    if (res.kind !== "element") return;
    // And the probe reports ONE match, because the recipe is already `.first()`.
    // A native engine, with no legacy to preserve, refuses at `resolve`.
    expect(await elements.probe(res.el, { matches: true })).toMatchObject({ matches: 1 });
  });

  it("narrows every locator tier through `.first()`", async () => {
    // The mechanism behind the line above, asserted on the builder itself so a
    // tier that stopped narrowing is caught here rather than in a flaky action.
    const refs = new RefRegistry();
    const calls: string[] = [];
    const node = { first: () => ({ __first: true }) };
    const page = {
      locator: (s: string) => {
        calls.push(`locator:${s}`);
        return node;
      },
      getByRole: (r: string) => {
        calls.push(`role:${r}`);
        return node;
      },
    } as unknown as Page;
    const tiers = [
      refs.forKey("t-testid", { role: "button", testId: "x", testIdAttr: "data-testid" }),
      refs.forKey("t-dom", { role: "td", cssPath: "table td", source: "dom" }),
      refs.forKey("t-role-name", { role: "button", name: "Save", source: "a11y" }),
      refs.forKey("t-css", { role: "generic", cssPath: "main > div", source: "both" }),
      refs.forKey("t-role-only", { role: "button", source: "a11y" }),
    ];
    for (const ref of tiers) {
      expect(locatorFor(page, refs, { ref })).toMatchObject({ __first: true });
    }
    expect(calls).toHaveLength(tiers.length);
  });

  it("keeps the two ambiguity warnings verbatim, and unreachable through `.first()`", async () => {
    // BOTH halves matter. The literals are pinned so a later phase cannot reword
    // the agent-facing text by accident. The reachability assertion is the
    // finding: because `locatorFor` returns a `.first()` locator,
    // `resolveTargetChecked`'s `primary.count()` is 0 or 1 and the `count > 1`
    // branch — with both of those warnings in it — cannot fire in production.
    // `locator.test.ts` exercises it only because its mock lets `.first().count()`
    // exceed one.
    const refs = new RefRegistry();
    const ref = testIdRef(refs, "edit");
    refs.updateLocator(ref, {
      role: "button",
      testId: "edit",
      testIdAttr: "data-testid",
      cssPath: "main > div:nth-child(7) > button.edit",
      source: "both",
    });
    const page = mockPage({
      '[data-testid="edit"]': { matches: 6 },
      "main > div:nth-child(7) > button.edit": { matches: 1 },
    });
    const { warning } = await resolveTargetChecked(page, refs, { ref });
    expect(
      warning,
      "the ambiguity branch is unreachable while locatorFor narrows to .first(); " +
        "if this now warns, the narrowing was removed and the behaviour change is live",
    ).toBeUndefined();

    // The sentences the branch would emit, pinned against the source itself so a
    // reword is a test failure even while the branch stays unreachable. The
    // agent-facing text is part of the behaviour P2 is preserving, and dead text
    // is exactly the kind that gets edited without anyone noticing.
    const source = readFileSync(new URL("./locator.ts", import.meta.url), "utf8");
    for (const sentence of [
      "the primary locator is ambiguous (${count} matches) ",
      "on .first() — verify the result, the element may have moved or re-rendered.",
      "Re-resolved to the concrete element captured when the ref was found, ",
    ]) {
      expect(source, `the ambiguity warning was reworded: ${sentence}`).toContain(sentence);
    }
  });
});
