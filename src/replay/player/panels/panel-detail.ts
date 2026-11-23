/// <reference lib="dom" />
// The details pane the network and console panels share (RFC 0007).
//
// A panel picks a row, a pure selector turns that row into `DetailSection`s,
// and this file draws them. The selectors never touch the DOM, so what a pane
// shows is unit-testable, and everything drawn here goes in through
// `textContent`. A header value, a body or a stack is page content, so it is
// never parsed as markup.
//
// Every value arrives already masked: registered secrets were replaced at
// capture and a dropped header or body arrives as the `{redacted, reason}`
// marker. The pane renders the marker as `[redacted: reason]` through the same
// `displayText` the table cells use, and it adds nothing the log does not carry.

import { isRedacted } from "../../schema.js";
import { displayText, el } from "./panel-ui.js";

/** One long body is one long text node, not a reason to freeze the tab. */
export const MAX_DETAIL_CHARS = 20_000;

export interface DetailField {
  label: string;
  value: unknown;
  /** What to show when it differs from the value, a formatted size say. The
   *  redaction marking still comes off `value`. */
  text?: string;
}

export interface DetailSection {
  id: string;
  title: string;
  /** Label and value pairs, in the order shown. */
  fields?: readonly DetailField[];
  /** A block of text: a body, a stack. */
  text?: unknown;
  /** What to say when the section has neither fields nor text. Naming the gap
   *  is the point: "not captured at this tier" and "nothing was sent" are
   *  different facts. */
  empty?: string;
}

export const DETAIL_PLACEHOLDER = "Select a row to see its details.";

/** Text for a block, cut to the display cap. `cut` is how many characters were
 *  left out, so the pane can say so. */
export function blockText(value: unknown): { text: string; cut: number } {
  const full = displayText(value, Number.POSITIVE_INFINITY);
  if (full.length <= MAX_DETAIL_CHARS) return { text: full, cut: 0 };
  return { text: full.slice(0, MAX_DETAIL_CHARS), cut: full.length - MAX_DETAIL_CHARS };
}

function fieldNode(field: DetailField): HTMLElement {
  const row = el("div", "pd-row");
  const value = el(
    "span",
    "pd-value",
    field.text ?? displayText(field.value, Number.POSITIVE_INFINITY),
  );
  if (isRedacted(field.value)) value.dataset.redacted = field.value.reason;
  row.append(el("span", "pd-label", field.label), value);
  return row;
}

function sectionNode(section: DetailSection): HTMLElement {
  const node = el("section", "pd-section");
  node.dataset.section = section.id;
  node.append(el("h3", "pd-title", section.title));
  if (section.fields !== undefined && section.fields.length > 0) {
    node.append(...section.fields.map(fieldNode));
    return node;
  }
  if (section.text !== undefined) {
    const block = blockText(section.text);
    const pre = el("pre", "pd-block", block.text);
    if (isRedacted(section.text)) pre.dataset.redacted = section.text.reason;
    node.append(pre);
    if (block.cut > 0) {
      node.append(el("p", "pd-note", `${block.cut.toLocaleString()} more characters not shown.`));
    }
    return node;
  }
  node.dataset.empty = "true";
  node.append(el("p", "pd-note", section.empty ?? "Nothing recorded."));
  return node;
}

export function renderDetail(
  pane: HTMLElement,
  heading: string,
  sections: readonly DetailSection[],
): void {
  pane.dataset.state = "selected";
  pane.replaceChildren(el("h2", "pd-heading", heading), ...sections.map(sectionNode));
}

export function clearDetail(pane: HTMLElement, text = DETAIL_PLACEHOLDER): void {
  pane.dataset.state = "empty";
  pane.replaceChildren(el("p", "pd-placeholder", text));
}

/** The pane itself. It is first in the panel's DOM order, so a keyboard user
 *  reaches it in one stop before the rows, and it scrolls on its own. */
export function detailPane(label: string): HTMLElement {
  const pane = el("aside", "panel-detail");
  pane.tabIndex = 0;
  pane.setAttribute("aria-label", label);
  clearDetail(pane);
  return pane;
}
