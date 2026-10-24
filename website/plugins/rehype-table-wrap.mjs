// Mark tables that wrap their cells on a phone, at build time.
//
// docs-enhance.ts used to set data-browx-wrap after the page script ran, which
// flipped a table from sideways-scroll to wrapped layout once the main thread
// freed up and shifted the page (CLS 0.45 on the tool reference). Deciding it
// here puts the attribute in the served HTML, so the first layout is the final
// one. The rule is the same: few columns and no long code token.
export default function rehypeTableWrap() {
  return (tree) => walk(tree);
}

function walk(node) {
  if (!node || !Array.isArray(node.children)) return;
  for (const child of node.children) {
    if (child.type === "element" && child.tagName === "table" && wraps(child)) {
      child.properties = { ...child.properties, dataBrowxWrap: "" };
    }
    walk(child);
  }
}

const isEl = (n, ...names) => n?.type === "element" && names.includes(n.tagName);

function firstRow(table) {
  const find = (n) => {
    for (const c of n.children ?? []) {
      if (isEl(c, "tr")) return c;
      const r = isEl(c, "thead", "tbody", "tfoot") ? find(c) : undefined;
      if (r) return r;
    }
    return undefined;
  };
  return find(table);
}

function text(node) {
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(text).join("");
}

function longestCode(node, acc = { max: 0 }, inCell = false) {
  for (const c of node.children ?? []) {
    if (c.type !== "element") continue;
    const cell = inCell || isEl(c, "td", "th");
    if (cell && c.tagName === "code") acc.max = Math.max(acc.max, text(c).length);
    longestCode(c, acc, cell);
  }
  return acc.max;
}

function wraps(table) {
  const row = firstRow(table);
  const cols = (row?.children ?? []).filter((c) => isEl(c, "th", "td")).length;
  const longest = longestCode(table);
  return cols <= 3 ? longest <= 40 : cols === 4 && longest <= 24;
}
