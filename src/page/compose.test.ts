//  compose tests. The surface area on compose is the new
// `opts.pierce` knob. Two things to assert:
//   1. Back-compat — omitting `opts` (or passing `{}`) produces a result
//      whose shape is byte-identical to pre-v0.5.0 (no `closedShadowEntries`
//      stat, no -only warnings).
//   2. Pierce-closed — when CDP refuses pierce we fall back to open-only +
//      surface a warning; when CDP returns closed candidates we merge them
//      into the tree.
//
// All CDP work is faked — no Playwright/Chromium here.

import { describe, it, expect, vi } from "vitest";
import type { CDPSession } from "playwright-core";
import { composeSnapshot } from "./compose.js";
import { serialise } from "./snapshot.js";
import { RefRegistry } from "./refs.js";
import type { A11yNode } from "./a11y-types.js";

function fakeCdp(sendImpl: (method: string, params?: unknown) => Promise<unknown>): CDPSession {
  return { send: vi.fn(sendImpl) } as unknown as CDPSession;
}

// Minimal a11y / DOM-walk / pierce stubs. Each `cdp.send` method is
// matched on by string; unmatched methods throw to surface coverage gaps.
function happyPathCdp(opts: { closedAvailable?: boolean; pierceFails?: boolean } = {}): CDPSession {
  return fakeCdp(async (method, params) => {
    switch (method) {
      case "Accessibility.enable":
        return {};
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "1",
              role: { value: "WebArea" },
              name: { value: "Page" },
              childIds: ["2"],
            },
            {
              nodeId: "2",
              parentId: "1",
              role: { value: "button" },
              name: { value: "Open" },
              backendDOMNodeId: 100,
            },
          ],
        };
      case "DOM.getAttributes":
        // Avoid testId enrichment in this unit test — return empty.
        return { attributes: [] };
      case "Runtime.evaluate":
        // The DOM-walk page script returns []. The OPEN_SHADOW_WALK
        // (called by shadow_trees) isn't exercised here.
        return { result: { value: [] } };
      case "DOM.getDocument": {
        if (opts.pierceFails) throw new Error("pierce unsupported on this build");
        const closedRoot = opts.closedAvailable
          ? [
              {
                nodeType: 9,
                nodeName: "#document-fragment",
                shadowRootType: "closed" as const,
                children: [
                  {
                    nodeType: 1,
                    localName: "button",
                    nodeName: "BUTTON",
                    backendNodeId: 999,
                    attributes: ["data-testid", "closed-cta"],
                    children: [],
                  },
                ],
              },
            ]
          : [];
        return {
          root: {
            nodeType: 9,
            nodeName: "#document",
            backendNodeId: 1,
            children: [
              {
                nodeType: 1,
                localName: "html",
                nodeName: "HTML",
                backendNodeId: 2,
                children: [
                  {
                    nodeType: 1,
                    localName: "my-app",
                    nodeName: "MY-APP",
                    backendNodeId: 10,
                    children: [],
                    shadowRoots: closedRoot,
                  },
                ],
              },
            ],
          },
        };
      }
      default:
        throw new Error(`unexpected CDP method ${method} (params=${JSON.stringify(params)})`);
    }
  });
}

/** A page whose a11y tree is a bare root and whose DOM walk finds one button —
 *  the silent-degradation shape, and the one where a second snapshot used to
 *  change its own answer. */
function domWalkOnlyCdp(): CDPSession {
  return fakeCdp(async (method) => {
    switch (method) {
      case "Accessibility.enable":
        return {};
      case "Accessibility.getFullAXTree":
        return { nodes: [{ nodeId: "1", role: { value: "RootWebArea" } }] };
      case "Runtime.evaluate":
        return {
          result: {
            value: [{ role: "button", name: "Only DOM", structuralPath: "body/button[0]" }],
          },
        };
      default:
        throw new Error(`unexpected CDP method ${method}`);
    }
  });
}

describe("composeSnapshot —  back-compat", () => {
  it("omitting `opts` produces no stats and no warnings", async () => {
    const cdp = happyPathCdp();
    const refs = new RefRegistry();
    const out = await composeSnapshot(cdp, refs, ["data-testid"]);
    expect(out.stats).not.toHaveProperty("closedShadowEntries");
    expect(out.warnings.some((w) => w.toLowerCase().includes("closed"))).toBe(false);
    // `DOM.getDocument` runs — the test-attribute sweep is one roundtrip
    // (9-39 ms on the four heaviest pages measured) and replaces a
    // `DOM.getAttributes` per node that failed on every call. What must NOT
    // run unasked is the closed-shadow PIERCE, which is a second sweep.
    const getDocumentCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "DOM.getDocument",
    );
    expect(getDocumentCalls).toHaveLength(1);
    expect(getDocumentCalls[0]![1]).toEqual({ depth: -1 });
  });

  it("passing `{}` is identical to omitting opts", async () => {
    const cdp = happyPathCdp();
    const refs = new RefRegistry();
    const out = await composeSnapshot(cdp, refs, ["data-testid"], {});
    expect(out.stats).not.toHaveProperty("closedShadowEntries");
  });
});

describe("composeSnapshot — stats.tier names the tier that carried the snapshot", () => {
  it("reports `a11y` when the accessibility tree supplied the content", async () => {
    // The fixture's DOM walk returns [], so only the a11y tier contributes.
    const out = await composeSnapshot(happyPathCdp(), new RefRegistry(), ["data-testid"]);
    expect(out.stats.tier).toBe("a11y");
  });

  it("reports `dom-walk` when the a11y tier found nothing interactive", async () => {
    // Root only, no interactive descendants — the silent-degradation case.
    const out = await composeSnapshot(domWalkOnlyCdp(), new RefRegistry(), ["data-testid"]);
    expect(out.stats.a11yInteractive).toBe(0);
    expect(out.stats.domWalkNew).toBe(1);
    expect(out.stats.tier).toBe("dom-walk");
  });

  it("reports the same tier on the second snapshot of an unchanged page", async () => {
    // The registry is per-session and remembers every snapshot, so keying
    // `domWalkNew` off it made the second snapshot of an identical page report
    // `domWalkNew: 0` and `tier: "empty"` while the DOM walk was still carrying
    // the whole thing. Both existing tier tests used a fresh registry, which is
    // exactly the case that never showed the bug.
    const refs = new RefRegistry();
    const cdp = domWalkOnlyCdp();
    const first = await composeSnapshot(cdp, refs, ["data-testid"]);
    const second = await composeSnapshot(cdp, refs, ["data-testid"]);
    expect(second.stats).toEqual(first.stats);
    expect(second.stats.tier).toBe("dom-walk");
    expect(second.stats.domWalkNew).toBe(1);
    expect(second.stats.domWalkCombined).toBe(0);
  });

  it("keeps a DOM-walk node marked [from-dom] across re-snapshots", async () => {
    // Same reading of the registry flipped the provenance marker: identical
    // page, and the second snapshot said `[from-both]` — "both tiers found
    // this" — about a node only the DOM walk ever saw.
    const refs = new RefRegistry();
    const cdp = domWalkOnlyCdp();
    const first = await composeSnapshot(cdp, refs, ["data-testid"]);
    const second = await composeSnapshot(cdp, refs, ["data-testid"]);
    expect(serialise(first.tree!)).toContain("[from-dom]");
    expect(serialise(second.tree!)).toBe(serialise(first.tree!));
  });
});

describe("composeSnapshot —  pierce: 'closed'", () => {
  it("merges closed-shadow candidates and surfaces the inspect-only warning", async () => {
    const cdp = happyPathCdp({ closedAvailable: true });
    const refs = new RefRegistry();
    const out = await composeSnapshot(cdp, refs, ["data-testid"], { pierce: "closed" });
    expect(out.stats.closedShadowEntries).toBeGreaterThanOrEqual(1);
    expect(out.warnings.some((w) => w.includes("CLOSED shadow root"))).toBe(true);
    // The CDP call was made.
    const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toContain("DOM.getDocument");
  });

  it("when CDP pierce fails, warns + falls back without crashing", async () => {
    const cdp = happyPathCdp({ pierceFails: true });
    const refs = new RefRegistry();
    const out = await composeSnapshot(cdp, refs, ["data-testid"], { pierce: "closed" });
    expect(out.stats.closedShadowEntries).toBe(0);
    expect(out.warnings.some((w) => w.includes("closed-shadow piercing unavailable"))).toBe(true);
    // Tree still composed — open-shadow / a11y data unaffected.
    expect(out.tree).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The tier join. The two tiers used to duplicate every element: their ref keys
// speak different vocabularies (ARIA role + accessibility path against bare tag
// + DOM path), so the same `<a>` was `link` at one key and `a` at another and
// no entry ever matched. They meet on the backend node id instead, resolved
// through the `DOM.getDocument` sweep by the `:nth-child` path the DOM walk
// already reports.

interface FakeEntry {
  role: string;
  name: string;
  testId: string;
  testIdAttr: string;
  tag: string;
  id: string;
  structuralPath: string;
  cssPath: string;
}

function entry(over: Partial<FakeEntry> & { role: string; cssPath: string }): FakeEntry {
  return {
    name: "",
    testId: "",
    testIdAttr: "",
    tag: over.role,
    id: "",
    structuralPath: over.cssPath,
    ...over,
  };
}

/** One document, seen by both tiers. `axNodes` are the AX tree's children of
 *  the root; `bodyChildren` are `<body>`'s element children as `DOM.getDocument`
 *  reports them; `entries` are what the page walk found. */
function twoTierCdp(
  axNodes: Array<Record<string, unknown>>,
  bodyChildren: Array<Record<string, unknown>>,
  entries: FakeEntry[],
): CDPSession {
  return fakeCdp(async (method) => {
    switch (method) {
      case "Accessibility.enable":
        return {};
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "1",
              role: { value: "WebArea" },
              name: { value: "Page" },
              childIds: axNodes.map((_, i) => String(i + 2)),
            },
            ...axNodes.map((n, i) => ({ nodeId: String(i + 2), parentId: "1", ...n })),
          ],
        };
      case "Runtime.evaluate":
        return { result: { value: entries } };
      case "DOM.getDocument":
        return {
          root: {
            nodeType: 9,
            nodeName: "#document",
            backendNodeId: 1,
            children: [
              {
                nodeType: 1,
                localName: "html",
                nodeName: "HTML",
                backendNodeId: 2,
                children: [
                  { nodeType: 1, localName: "head", nodeName: "HEAD", backendNodeId: 3 },
                  {
                    nodeType: 1,
                    localName: "body",
                    nodeName: "BODY",
                    backendNodeId: 4,
                    children: bodyChildren,
                  },
                ],
              },
            ],
          },
        };
      default:
        throw new Error(`unexpected CDP method ${method}`);
    }
  });
}

const BUTTON_PATH = "body:nth-child(2) > button:nth-child(1)";
const OPEN_BUTTON = [{ role: { value: "button" }, name: { value: "Open" }, backendDOMNodeId: 100 }];
const OPEN_BUTTON_DOM = [
  { nodeType: 1, localName: "button", nodeName: "BUTTON", backendNodeId: 100 },
];

function lineFor(tree: A11yNode, needle: string): string {
  const line = serialise(tree)
    .split("\n")
    .find((l) => l.includes(needle));
  if (!line) throw new Error(`no line matching ${needle} in:\n${serialise(tree)}`);
  return line;
}

function refIn(line: string): string {
  return /\[ref=(e\d+)\]/.exec(line)![1]!;
}

describe("composeSnapshot — the two tiers report one element once", () => {
  it("folds a DOM-walk entry into the a11y node for the same element", async () => {
    const out = await composeSnapshot(
      twoTierCdp(OPEN_BUTTON, OPEN_BUTTON_DOM, [
        entry({ role: "button", name: "Open", cssPath: BUTTON_PATH }),
      ]),
      new RefRegistry(),
      ["data-testid"],
    );
    expect(out.stats.domWalkCombined).toBe(1);
    expect(out.stats.domWalkNew).toBe(0);
    const lines = serialise(out.tree!).split("\n");
    // One line, the a11y tier's — the ARIA role `button`, not the bare tag.
    expect(lines.filter((l) => l.includes('"Open"'))).toHaveLength(1);
    expect(lineFor(out.tree!, '"Open"')).toContain("[from-both]");
  });

  it("gives the folded node the walk's cssPath, so an ambiguous ref re-resolves", async () => {
    const refs = new RefRegistry();
    const out = await composeSnapshot(
      twoTierCdp(OPEN_BUTTON, OPEN_BUTTON_DOM, [
        entry({ role: "button", name: "Open", cssPath: BUTTON_PATH }),
      ]),
      refs,
      ["data-testid"],
    );
    const inputs = refs.locatorOf(refIn(lineFor(out.tree!, '"Open"')))!;
    expect(inputs.cssPath).toBe(BUTTON_PATH);
    // The a11y tier's role and name stand; provenance says both tiers saw it.
    expect(inputs.role).toBe("button");
    expect(inputs.name).toBe("Open");
    expect(inputs.source).toBe("both");
  });

  it("keeps two elements with the same role and the same name apart", async () => {
    // The false-merge case. Matching on role + name would collapse these into
    // one ref that acts on whichever came first; the backend node id does not.
    const second = "body:nth-child(2) > button:nth-child(2)";
    const refs = new RefRegistry();
    const out = await composeSnapshot(
      twoTierCdp(
        [
          { role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 100 },
          { role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 101 },
        ],
        [
          { nodeType: 1, localName: "button", nodeName: "BUTTON", backendNodeId: 100 },
          { nodeType: 1, localName: "button", nodeName: "BUTTON", backendNodeId: 101 },
        ],
        [
          entry({ role: "button", name: "Save", cssPath: BUTTON_PATH }),
          entry({ role: "button", name: "Save", cssPath: second }),
        ],
      ),
      refs,
      ["data-testid"],
    );
    expect(out.stats.domWalkCombined).toBe(2);
    const lines = serialise(out.tree!)
      .split("\n")
      .filter((l) => l.includes('"Save"'));
    expect(lines).toHaveLength(2);
    const seen = lines.map(refIn);
    expect(new Set(seen).size).toBe(2);
    // Each ref carries its own element's path.
    expect(refs.locatorOf(seen[0]!)!.cssPath).toBe(BUTTON_PATH);
    expect(refs.locatorOf(seen[1]!)!.cssPath).toBe(second);
  });

  it("refuses to fold into a node the serialiser emits no line for", async () => {
    // A nameless `generic` prints nothing, so folding the entry into it would
    // take the element out of the snapshot instead of deduplicating it.
    const divPath = "body:nth-child(2) > div:nth-child(1)";
    const out = await composeSnapshot(
      twoTierCdp(
        [{ role: { value: "generic" }, backendDOMNodeId: 100 }],
        [
          {
            nodeType: 1,
            localName: "div",
            nodeName: "DIV",
            backendNodeId: 100,
            attributes: ["data-testid", "widget"],
          },
        ],
        [entry({ role: "div", testId: "widget", testIdAttr: "data-testid", cssPath: divPath })],
      ),
      new RefRegistry(),
      ["data-testid"],
    );
    expect(out.stats.domWalkNew).toBe(1);
    expect(out.stats.domWalkCombined).toBe(0);
    expect(serialise(out.tree!)).toContain("[from-dom]");
  });

  it("appends an entry whose path the sweep cannot resolve", async () => {
    // A shadow-rooted element's path stops at the shadow boundary, and a
    // closed-shadow entry carries no path at all. Neither is in the sweep, so
    // neither merges — the pre-join behaviour, which is the safe one.
    const out = await composeSnapshot(
      twoTierCdp(OPEN_BUTTON, OPEN_BUTTON_DOM, [
        entry({ role: "button", name: "Open", cssPath: "button:nth-child(1)" }),
      ]),
      new RefRegistry(),
      ["data-testid"],
    );
    expect(out.stats.domWalkCombined).toBe(0);
    expect(out.stats.domWalkNew).toBe(1);
  });

  it("refuses when the element at the path disagrees about its test attribute", async () => {
    // The sweep and the walk run milliseconds apart. If the element at a path
    // changed in between, the path is no longer an identity.
    const out = await composeSnapshot(
      twoTierCdp(
        OPEN_BUTTON,
        [
          {
            nodeType: 1,
            localName: "button",
            nodeName: "BUTTON",
            backendNodeId: 100,
            attributes: ["data-testid", "swapped-in"],
          },
        ],
        [entry({ role: "button", name: "Open", cssPath: BUTTON_PATH })],
      ),
      new RefRegistry(),
      ["data-testid"],
    );
    expect(out.stats.domWalkCombined).toBe(0);
    expect(out.stats.domWalkNew).toBe(1);
  });

  it("reports the same body and the same counts on the second snapshot", async () => {
    const refs = new RefRegistry();
    const cdp = twoTierCdp(OPEN_BUTTON, OPEN_BUTTON_DOM, [
      entry({ role: "button", name: "Open", cssPath: BUTTON_PATH }),
    ]);
    const first = await composeSnapshot(cdp, refs, ["data-testid"]);
    const second = await composeSnapshot(cdp, refs, ["data-testid"]);
    expect(second.stats).toEqual(first.stats);
    expect(serialise(second.tree!)).toBe(serialise(first.tree!));
  });
});
