// Strip agent-facing callouts from the rendered HTML.
//
// Agent guidance is authored inline as a blockquote whose lead reads
// "For agents - ..." (and, for parity with the wider docs platform, as a
// Starlight aside titled "For agents"). On the human-rendered site these
// callouts are removed entirely; the same guidance is preserved verbatim in the
// page source and served from the plaintext .md endpoint (linked from
// llms.txt), so agents still get it while end users see a focused page.
//
// No unified/unist dependency - a small hast walk keeps the build's dependency
// surface unchanged.
export default function rehypeStripAgentAsides() {
  return (tree) => walk(tree);
}

function walk(node) {
  if (!node || !Array.isArray(node.children)) return;
  node.children = node.children.filter((child) => !isAgentCallout(child));
  for (const child of node.children) walk(child);
}

function isAgentCallout(node) {
  if (node?.type !== "element") return false;
  if (node.tagName === "aside" && hasForAgentsLabel(node)) return true;
  if (node.tagName === "blockquote" && startsWithForAgents(node)) return true;
  return false;
}

function hasForAgentsLabel(node) {
  const props = node.properties ?? {};
  const label = props.ariaLabel ?? props["aria-label"];
  return typeof label === "string" && label.trim().toLowerCase() === "for agents";
}

/** True when the blockquote's leading text (often inside <strong>) starts with
 * "For agents" (case-insensitive). */
function startsWithForAgents(node) {
  return /^for agents\b/i.test(leadingText(node).trimStart());
}

/** Collect the blockquote's text content in document order, enough to inspect
 * the leading words. */
function leadingText(node) {
  let out = "";
  const visit = (n) => {
    if (out.length > 64) return;
    if (n?.type === "text") {
      out += n.value;
      return;
    }
    if (Array.isArray(n?.children)) for (const c of n.children) visit(c);
  };
  visit(node);
  return out;
}
