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

// Layout guards for the rendered audit (hallmark 34, 44d and 49a). Each is true
// when some rule in the stylesheet carries the declarations, and the runner
// reports a finding when no stylesheet does.
//
//   copyable-scroll  .browx-copyable keeps white-space: nowrap, overflow-x: auto
//                    and a 44px min-height, so a long command scrolls in its chip.
//   container-cap    the landing and 404 main has a max-width of 1360 to 1520px.
//   code-wrap        inline code in running text has overflow-wrap: anywhere.

const rulesFor = (css, test) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => test(sel.replace(/\s+/g, " ").trim()))
    .map(([, , body]) => body)
    .join(";");

export const hasCopyableScroll = (css) => {
  const body = rulesFor(css, (s) => /(^|,\s*)\.browx-copyable$/.test(s));
  return (
    /white-space:\s*nowrap/.test(body) &&
    /overflow-x:\s*auto/.test(body) &&
    /min-height:\s*var\(--browx-tap\)/.test(body)
  );
};

export const hasContainerCap = (css) => {
  const body = rulesFor(css, (s) => /main:has\(\.browx-hero\)/.test(s) && !/>/.test(s));
  const px = /max-width:\s*(\d+)px/.exec(body);
  return !!px && +px[1] >= 1360 && +px[1] <= 1520 && /margin-inline:\s*auto/.test(body);
};

export const hasCodeWrap = (css) =>
  /sl-markdown-content[^{}]*\bcode[^{}]*\{[^{}]*overflow-wrap:\s*anywhere/.test(css);

/** Record which layout guards a stylesheet satisfies. */
export function noteLayout(css, seen) {
  if (hasCopyableScroll(css)) seen.copyable = true;
  if (hasContainerCap(css)) seen.container = true;
  if (hasCodeWrap(css)) seen.codeWrap = true;
}

/** The layout guards no stylesheet satisfied, as [rule, detail]. */
export const layoutMissing = (seen) =>
  [
    !seen.copyable && ["copyable-scroll", ".browx-copyable needs nowrap, overflow-x: auto, 44px"],
    !seen.container && ["container-cap", "landing and 404 main needs max-width 1360 to 1520px"],
    !seen.codeWrap && ["code-wrap", "inline code in content needs overflow-wrap: anywhere"],
  ].filter(Boolean);
