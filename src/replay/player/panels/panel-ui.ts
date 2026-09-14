/// <reference lib="dom" />
// Shared rendering for the four panels (RFC 0007 P3). Two halves, deliberately
// in one file: the text a cell shows, and the node it shows it in.
//
// The redaction marker is the load-bearing part. A redacted field arrives as
// the `{redacted, reason}` marker from `../../schema.ts`, and the artifact
// records THAT something was removed precisely so a reviewer can tell it from
// "nothing was there". Rendering it as an empty cell throws that away, and
// rendering it as `[object Object]` is worse. So every value a panel shows goes
// through `displayText`, and the cell carries `data-redacted` for the CSS.

import { isRedacted } from "../../schema.js";
import { formatMs } from "../view.js";

export { formatMs };

/** Long enough to recognise a URL or a frame, short enough that one row stays
 *  one row. The full value stays in the cell's `title`. */
const MAX_CELL_CHARS = 180;

export const EM_DASH = "—";

export function displayText(value: unknown, maxChars = MAX_CELL_CHARS): string {
  if (isRedacted(value)) return `[redacted: ${value.reason}]`;
  if (value === undefined || value === null) return EM_DASH;
  const text = typeof value === "string" ? value : safeJson(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Bytes, or the redaction marker when the size came from a header that was
 *  taken out. `undefined` means the log never carried a size, which is a
 *  different fact from zero and reads as one. */
export function formatBytes(value: unknown): string {
  if (isRedacted(value)) return displayText(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return EM_DASH;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `text` overrides what the cell SHOWS (a formatted size, say) without
 *  changing what it is: the redaction marking still comes off `value`. */
export function cell(value: unknown, className = "", text = displayText(value)): HTMLElement {
  const node = el("span", `pcell ${className}`.trim(), text);
  if (isRedacted(value)) node.dataset.redacted = value.reason;
  else if (typeof value === "string" && value.length > MAX_CELL_CHARS) node.title = value;
  return node;
}

/** A clickable row. `t` is what the host's delegated listener seeks to, so a
 *  panel never holds a reference to the timeline. */
export function row(t: number, className: string, cells: readonly HTMLElement[]): HTMLElement {
  const node = el("button", `prow ${className}`.trim());
  (node as HTMLButtonElement).type = "button";
  node.dataset.t = String(Math.round(t));
  node.append(...cells);
  return node;
}

export function headRow(className: string, labels: readonly string[]): HTMLElement {
  const node = el("div", `prow prow-head ${className}`.trim());
  node.append(...labels.map((label) => el("span", "pcell", label)));
  return node;
}

/** The empty state. A panel over an event type the log does not contain says so
 *  and renders nothing else — it never fails to mount. */
export function emptyState(text: string, hint?: string): HTMLElement {
  const node = el("div", "panel-empty");
  node.dataset.empty = "true";
  node.append(el("p", "panel-empty-text", text));
  if (hint) node.append(el("p", "panel-empty-hint", hint));
  return node;
}

/** The "showing the newest N of M" line. A bounded row window is honest only if
 *  the player says what it left out. */
export function overflowNote(hidden: number, noun: string): HTMLElement | undefined {
  if (hidden <= 0) return undefined;
  return el("div", "panel-note", `${hidden} earlier ${noun} not shown.`);
}

export function badge(text: string, kind: string): HTMLElement {
  const node = el("span", `pbadge pbadge-${kind}`, text);
  node.dataset.badge = kind;
  return node;
}
