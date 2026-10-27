// Type guards for check-design-rules.mjs, one declaration at a time. They hold
// the fixes for the rendered design audit (impeccable overused-font, tight-leading
// and line-length) so a later edit cannot bring the findings back.
//
//   flagged-font    a font-family naming a face the audit flags as overused.
//   tight-leading   a numeric line-height under 1.4 on running text (docs
//                   content, page outline, sidebar, table cells, paragraphs and
//                   lists), or --sl-line-height under 1.5 or
//                   --sl-line-height-headings under 1.3.
//   measure-range   a max-width in ch on the docs content column outside 70 to 75.
//                   A page that ends with no such cap fails too (see hasMeasure).

const FLAGGED = /\b(inter|roboto|fraunces|geist|plus jakarta sans|space grotesk)\b/i;
const RUNNING =
  /sl-markdown-content|starlight-toc|#starlight__sidebar|\b(td|th|p|li)\b|-lede|-about|-msg/;
const CONTENT = /sl-markdown-content/;

/** Why a declaration breaks a type guard, as [rule, detail], or null. */
export function typeFinding(selector, name, value, isCode) {
  if (name === "font-family" && FLAGGED.test(value.replace(/var\([^)]*\)/g, "")))
    return ["flagged-font", "(overused family in the stack)"];
  if (name === "--browx-font-body" && FLAGGED.test(value))
    return ["flagged-font", "(overused family in the stack)"];
  const n = parseFloat(value);
  if (
    /^\d*\.?\d+$/.test(value) &&
    name === "line-height" &&
    !isCode &&
    RUNNING.test(selector) &&
    n < 1.4
  )
    return ["tight-leading", "(running text needs 1.4 or more)"];
  if (name === "--sl-line-height" && n < 1.5) return ["tight-leading", "(body needs 1.5 or more)"];
  if (name === "--sl-line-height-headings" && n < 1.3)
    return ["tight-leading", "(headings need 1.3 or more)"];
  const ch = /^(\d*\.?\d+)ch$/.exec(value);
  if (name === "max-width" && ch && CONTENT.test(selector) && (+ch[1] < 70 || +ch[1] > 75))
    return ["measure-range", "(content column measure is 70 to 75ch)"];
  return null;
}

/** True when a rule on the docs content column caps its measure in ch. */
export const hasMeasure = (css) =>
  /sl-markdown-content[^{}]*\{[^{}]*max-width:\s*7[0-5]ch/.test(css);
