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

// Counts the cells of every row that is the first child of its section (the
// header row and the first body row), which is what the runtime check this
// replaced counted. Keeping the count keeps the same set of tables wrapped.
function cellCount(node, acc = { n: 0 }) {
  const kids = (node.children ?? []).filter((c) => c.type === "element");
  kids.forEach((c, i) => {
    if (isEl(c, "tr") && i === 0) acc.n += c.children.filter((x) => isEl(x, "th", "td")).length;
    if (isEl(c, "thead", "tbody", "tfoot")) cellCount(c, acc);
  });
  return acc.n;
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
  const cols = cellCount(table);
  const longest = longestCode(table);
  return cols <= 3 ? longest <= 40 : cols === 4 && longest <= 24;
}
