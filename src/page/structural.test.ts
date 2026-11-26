import { describe, it, expect } from "vitest";
import type { A11yNode } from "./a11y.js";
import { PLAIN_CUT, textCutFor } from "../util/frame-cap.js";
import { SecretRegistry } from "../util/secrets.js";
import { annotateStructuralContext, maskedContext, withMaskedContexts } from "./structural.js";

let refSeq = 0;
function n(role: string, name?: string, children: A11yNode[] = []): A11yNode {
  return { ref: `e${++refSeq}`, role, name, children };
}

describe("annotateStructuralContext", () => {
  it("annotates cells in a semantic table with row/column/rowText", () => {
    refSeq = 0;
    // table > [headerRow, dataRow1, dataRow2]
    const headerRow = n("row", undefined, [
      n("columnheader", "Date"),
      n("columnheader", "Type"),
      n("columnheader", "Task"),
    ]);
    const cellDate = n("cell", "Wed, May 13");
    const cellType = n("cell", "Engineering");
    const cellTask = n("cell", "Reviewed PR");
    const dataRow1 = n("row", undefined, [cellDate, cellType, cellTask]);
    const dataRow2 = n("row", undefined, [
      n("cell", "Thu, May 14"),
      n("cell", "Support"),
      n("cell", "Triage"),
    ]);
    const table = n("table", "Records", [headerRow, dataRow1, dataRow2]);
    const root = n("WebArea", "Page", [table]);

    annotateStructuralContext(root);

    expect(cellType.context).toBeDefined();
    expect(cellType.context?.collection).toBe("table");
    expect(cellType.context?.column).toBe("Type");
    expect(cellType.context?.rowKey).toBe("Wed, May 13");
    expect(cellType.context?.rowText).toContain("Engineering");
    expect(cellType.context?.rowText).toContain("Reviewed PR");

    // Different row → different rowKey, same collection.
    expect(dataRow2.children[1]!.context?.rowKey).toBe("Thu, May 14");
    expect(dataRow2.children[1]!.context?.column).toBe("Type");
  });

  it("propagates context to grandchildren of a cell (e.g. button inside a cell)", () => {
    refSeq = 0;
    const innerBtn = n("button", "Delete row");
    const cell = n("cell", undefined, [innerBtn]);
    const row = n("row", undefined, [n("cell", "Wed, May 13"), cell]);
    const table = n("table", undefined, [
      n("row", undefined, [n("columnheader", "Date"), n("columnheader", "Action")]),
      row,
    ]);
    const root = n("WebArea", undefined, [table]);

    annotateStructuralContext(root);

    expect(innerBtn.context?.collection).toBe("table");
    expect(innerBtn.context?.rowKey).toBe("Wed, May 13");
    expect(innerBtn.context?.column).toBe("Action");
  });

  it("uses 'list' collection for listitem-based layouts (no column detection)", () => {
    refSeq = 0;
    const inner = n("button", "Open");
    const item = n("listitem", undefined, [n("text", "Item A"), inner]);
    const list = n("list", undefined, [item, n("listitem", undefined, [n("text", "Item B")])]);
    const root = n("WebArea", undefined, [list]);

    annotateStructuralContext(root);

    expect(inner.context?.collection).toBe("list");
    expect(inner.context?.rowKey).toBe("Item A");
    expect(inner.context?.column).toBeUndefined();
  });

  it.each([
    {
      name: "uses 'feed' collection for article descendants inside a feed",
      build: () => {
        const link = n("link", "Open post");
        const article = n("article", undefined, [n("heading", "Post title"), link]);
        const feed = n("feed", undefined, [
          article,
          n("article", undefined, [n("heading", "Other")]),
        ]);
        return { leaf: link, root: n("WebArea", undefined, [feed]) };
      },
      context: { collection: "feed", rowKey: "Post title" },
    },
    {
      // A row directly under a generic container (no `table`/`grid` ancestor).
      name: "falls back to '<row-role>-list' when the row has no canonical collection parent",
      build: () => {
        const cell = n("cell", "X");
        return { leaf: cell, root: n("WebArea", undefined, [n("row", undefined, [cell])]) };
      },
      context: { collection: "row-list" },
    },
  ])("$name", ({ build, context }) => {
    refSeq = 0;
    const { leaf, root } = build();

    annotateStructuralContext(root);

    expect(leaf.context).toMatchObject(context);
  });

  it("treats a standalone article (no feed ancestor) as not-a-row", () => {
    refSeq = 0;
    const link = n("link", "Read more");
    const article = n("article", undefined, [n("heading", "Title"), link]);
    const root = n("WebArea", undefined, [article]);

    annotateStructuralContext(root);

    expect(link.context).toBeUndefined();
  });

  it("caps rowText at 200 chars with an ellipsis", () => {
    refSeq = 0;
    const cells = Array.from({ length: 30 }, (_, i) =>
      n("cell", `Long-cell-text-${i}-aaaaaaaaaaaaaaaaaaaa`),
    );
    const row = n("row", undefined, cells);
    const root = n("WebArea", undefined, [n("table", undefined, [row])]);

    annotateStructuralContext(root);

    const t = cells[0]!.context?.rowText ?? "";
    expect(t.length).toBeLessThanOrEqual(200);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("row context over the cap is masked before it is cut", () => {
  const VALUE = "tok_0123456789abcdef";
  const secrets = new SecretRegistry();
  secrets.register({ name: "TOKEN", value: VALUE });
  const cut = textCutFor(secrets);

  function rowWith(first: string, rest: string): { cell: A11yNode; root: A11yNode } {
    const cell = n("cell", rest);
    const row = n("row", undefined, [n("cell", first), cell]);
    return { cell, root: n("WebArea", "Page", [n("table", "T", [row])]) };
  }

  it("masks a value across the 80-character rowKey cut", () => {
    const { cell, root } = rowWith("k".repeat(70) + VALUE, "other");
    annotateStructuralContext(root);
    expect(cell.context!.rowKey).toBe("k".repeat(70) + "tok_01234…");
    const masked = maskedContext(cell.context!, cut);
    expect(masked.rowKey).toBe("k".repeat(70) + "<TOKEN>");
    expect(masked.rowKey).not.toContain("tok_");
  });

  it("masks a value across the 200-character rowText cut", () => {
    const { cell, root } = rowWith("key", "t".repeat(190) + VALUE);
    annotateStructuralContext(root);
    const masked = maskedContext(cell.context!, cut);
    expect(masked.rowText).toHaveLength(200);
    expect(masked.rowText).not.toContain("tok_");
    expect(masked.rowText!.endsWith("…")).toBe(true);
  });

  it("returns the context as it is with no secret registered", () => {
    const { cell, root } = rowWith("k".repeat(90), "short");
    annotateStructuralContext(root);
    expect(maskedContext(cell.context!, PLAIN_CUT)).toBe(cell.context);
    expect(cell.context!.rowKey).toBe("k".repeat(79) + "…");
    expect(withMaskedContexts([{ context: cell.context }], PLAIN_CUT)[0]!.context).toBe(
      cell.context,
    );
  });
});
