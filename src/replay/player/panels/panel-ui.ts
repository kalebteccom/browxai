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
  if (isRedacted(value)) {
    // `reason` is typed, and this is a value off the wire, so it is also checked.
    const reason: unknown = value.reason;
    return typeof reason === "string" && reason !== "" ? `[redacted: ${reason}]` : "[redacted]";
  }
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

/** The text a filter matches against for one value: exactly what the panel
 *  would show for it, minus the display cap. A redaction marker matches on its
 *  `[redacted: reason]` text, so a reviewer can search for what was taken out. */
function searchableText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (isRedacted(value)) return displayText(value);
  if (typeof value === "string") return value;
  return displayText(value, Number.POSITIVE_INFINITY);
}

/** Case-insensitive substring match over the values a row shows. An empty or
 *  blank needle matches everything. Pure: the panels call it per row, and the
 *  unit tests call it without a DOM. */
export function matchesText(needle: string, values: readonly unknown[]): boolean {
  const wanted = needle.trim().toLowerCase();
  if (wanted === "") return true;
  return values.some((value) => searchableText(value).toLowerCase().includes(wanted));
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

/** Replace a list's rows and hand keyboard focus back to the row that had it.
 *  A panel re-renders on every seek, and a row a keyboard user just activated is
 *  one of the nodes that gets replaced; without this, focus drops to the page
 *  body and the next key press starts over from the top. Rows carry their
 *  identity in `data-key`. */
export function replaceKeepingFocus(container: HTMLElement, nodes: readonly HTMLElement[]): void {
  const active = document.activeElement;
  const key =
    active instanceof HTMLElement && container.contains(active) ? active.dataset.key : undefined;
  container.replaceChildren(...nodes);
  if (key === undefined) return;
  const again = container.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  again?.focus({ preventScroll: true });
}

/** A labelled text filter. The label is visible and wraps the input, so the
 *  control is named for assistive tech without a second element to keep in
 *  step. `id` is the stable hook tests drive. */
export function textFilter(
  id: string,
  label: string,
): { label: HTMLElement; input: HTMLInputElement } {
  const input = el("input", "panel-filter") as HTMLInputElement;
  input.type = "search";
  input.id = id;
  input.autocomplete = "off";
  input.spellcheck = false;
  const wrap = el("label", "control", `${label} `);
  wrap.append(input);
  return { label: wrap, input };
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

/** Selection and playhead state on a row, as attributes the CSS and the tests
 *  both read. `aria-pressed` says which row is open in the details pane, and
 *  `aria-current` says which row the playhead is on. */
export function setSelected(node: HTMLElement, selected: boolean): void {
  node.setAttribute("aria-pressed", String(selected));
  if (selected) node.dataset.selected = "true";
  else delete node.dataset.selected;
}

export function setCurrent(node: HTMLElement, current: boolean): void {
  if (current) {
    node.dataset.current = "true";
    node.setAttribute("aria-current", "true");
  } else {
    delete node.dataset.current;
    node.removeAttribute("aria-current");
  }
}

export function badge(text: string, kind: string): HTMLElement {
  const node = el("span", `pbadge pbadge-${kind}`, text);
  node.dataset.badge = kind;
  return node;
}
