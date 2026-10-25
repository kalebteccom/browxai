// Text carried onto snapshot rows. Chrome gives a paragraph, a nameless div, a
// list item or a blockquote an empty accessible name and puts the words on a
// `StaticText` child. The serialiser emits no line for `StaticText`, so without
// this module a page of prose reads as a column of bare `paragraph [ref=eN]`.
//
// Pure: no CDP, no Playwright. The serialiser owns the budget and the output.

import { PRESENTATIONAL_ROLES, type A11yNode } from "./a11y-types.js";

/** Longest text kept on one row. Longer text is cut with an ellipsis. */
export const MAX_ROW_TEXT = 120;

/** Total characters of carried text one `serialise` call may emit (about 1,000
 *  tokens). Past it, rows come out bare and a trailer line says so. */
export const TEXT_BUDGET = 4000;

/** Roles whose text is already their accessible name, or is the value of an
 *  input. A subtree under one of these never carries text: it would repeat the
 *  name, and under a text field it would print the field's value, including a
 *  password field's bullets. */
const TEXT_OWNING_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "heading",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "checkbox",
  "radio",
  "switch",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "term",
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
  "listbox",
  "progressbar",
  "meter",
  "img",
  "math",
]);

/** Document roots take the page title as their name, not their text. */
const DOCUMENT_ROLES: ReadonlySet<string> = new Set(["RootWebArea", "WebArea"]);

/** Text sitting straight under a document root has no paragraph to ride on. */
export function isDocumentRoot(role: string): boolean {
  return DOCUMENT_ROLES.has(role);
}

/** True when a node's own role means its text belongs to its name or value. */
export function ownsItsText(role: string): boolean {
  return TEXT_OWNING_ROLES.has(role);
}

/** Can this node carry text on its row? It needs no accessible name and a role
 *  that is not a text leaf, `none`, `presentation` or an input. A layout table cell can: it is
 *  where Chrome puts the words of a table used for page layout. */
export function canCarryText(node: Pick<A11yNode, "role" | "name" | "testId">): boolean {
  if (node.name || DOCUMENT_ROLES.has(node.role)) return false;
  if (node.role === "none" || node.role === "presentation") return false;
  if (TEXT_OWNING_ROLES.has(node.role)) return false;
  if (node.role === "LayoutTableCell") return true;
  if (PRESENTATIONAL_ROLES.has(node.role) && !node.testId) return false;
  return true;
}

/**
 * The text a node holds directly: its `StaticText` children in order, read
 * through text wrappers (`Abbr`, `superscript`, ...). A child that is its own
 * row (a link, an `emphasis` node, a nested paragraph) is not read, so each
 * word appears once. Whitespace is collapsed. Reading stops once `limit`
 * characters are collected, so a huge paragraph costs a bounded amount of work.
 */
export function ownText(node: A11yNode, limit: number = MAX_ROW_TEXT * 2): string {
  const parts: string[] = [];
  let length = 0;
  const stack: A11yNode[] = [];
  for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  // cap: reading stops once `limit` characters are collected, and the tree is finite.
  while (stack.length && length <= limit) {
    const n = stack.pop()!;
    if (n.testId) continue;
    if (n.role === "StaticText") {
      if (n.name) {
        parts.push(n.name);
        length += n.name.length;
      }
    } else if (n.role === "LineBreak") {
      parts.push(" ");
      length += 1;
    } else if (n.role !== "InlineTextBox" && n.role !== "ListMarker" && wrapsText(n.role)) {
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** Text wrappers only: a layout table cell is a row of its own, so it is not
 *  read through. */
function wrapsText(role: string): boolean {
  return PRESENTATIONAL_ROLES.has(role) && !role.startsWith("LayoutTable");
}

/** Cut `text` to `max` characters, ending in an ellipsis when it was cut. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/** Line breaks and tabs, including the ones `\s` misses (NEL, U+2028, U+2029). */
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
/** Control and format characters: C0/C1 controls, zero-width characters, bidi
 *  overrides and isolates, soft hyphens. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
/** A `[` that would open a `[ref=` token, with any case and spacing. */
const REF_OPENER = /\[(?=\s*ref\s*=)/gi;

/** Page text made safe to sit on a snapshot row: line breaks become spaces,
 *  control and format characters are dropped, and the `[` of any `[ref=` turns
 *  into `(`, so page text cannot put a ref on a row. Never lengthens the text. */
export function cleanPageText(text: string): string {
  return text.replace(LINE_BREAKS, " ").replace(CONTROL_OR_FORMAT, "").replace(REF_OPENER, "(");
}

/** Escape `\` and `"` the way JSON does, so text inside a row's quotes cannot
 *  close them. Run after any cut, so a cut never splits an escape. */
export function escapeQuoted(text: string): string {
  return text.replace(/[\\"]/g, (c) => `\\${c}`);
}
