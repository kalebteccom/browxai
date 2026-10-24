// Progressive enhancement for docs pages. Without JS the page reads the same.
// 1. Inline code that holds a command or a BROWX_* name copies on click, and on
//    Enter or Space when it is a tab stop (see FOCUS_LIMIT). The "Copied" bubble
//    is a ::after (see brand.css), so nothing reflows.
// 2. A table that scrolls sideways becomes focusable, so a keyboard can scroll it.
//    A table of short cells wraps on phone widths instead: rehype-table-wrap
//    marks it at build time (see brand.css), so nothing shifts after load.
// The work runs when the main thread is idle. The tool reference holds 15k nodes,
// and doing it before first input blocked the page for over a second.
// BROWX_NAME and BROWX_NAME=value both copy. A value with a placeholder or an
// ellipsis is not a command, so it stays plain.
const COMMAND = /^(?:(?:browxai|npx|pnpm|npm) \S|BROWX_[A-Z0-9_]+(?:=[^\s<…]+)?$)/;
const SKIP = "a, pre, summary, h1, h2, h3, h4, h5, h6";
// Landing cards sit in a .not-content block but hold real commands.
const skipped = (el: HTMLElement) =>
  Boolean(el.closest(SKIP)) ||
  (Boolean(el.closest(".not-content")) && !el.closest(".browx-card-text"));

const live = document.createElement("div");
live.className = "browx-sr-only";
live.setAttribute("role", "status");
document.body.append(live);

let active: HTMLElement | undefined;
let timer = 0;
const flash = (el: HTMLElement, state: "copied" | "failed") => {
  window.clearTimeout(timer);
  if (active && active !== el) delete active.dataset.copyState;
  active = el;
  el.dataset.copyState = state;
  live.textContent =
    state === "copied"
      ? `Copied ${el.textContent}`
      : "Copy failed. The text is selected, press Ctrl+C or Cmd+C.";
  const ms = state === "copied" ? 1600 : 4000;
  timer = window.setTimeout(() => {
    delete el.dataset.copyState;
    live.textContent = "";
  }, ms);
};

const copy = async (el: HTMLElement) => {
  try {
    await navigator.clipboard.writeText(el.textContent?.trim() ?? "");
    flash(el, "copied");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    flash(el, "failed");
  }
};

// Only short codes inside running text are tab stops, and only on a page with
// few of them. A page past FOCUS_LIMIT (the tool reference) keeps click-to-copy
// without the tab stops, and keyboard users copy from the block buttons.
const FOCUS_LIMIT = 60;
const FOCUS_MAX_CHARS = 80;
const focusable = (el: HTMLElement, text: string) =>
  text.length < FOCUS_MAX_CHARS && Boolean(el.closest("p, li, td, th"));

const enhance = () => {
  const copyable = [...document.querySelectorAll<HTMLElement>(".sl-markdown-content code")].filter(
    (el) => COMMAND.test(el.textContent?.trim() ?? "") && !skipped(el),
  );
  const focusCount = copyable.filter((el) => focusable(el, el.textContent?.trim() ?? "")).length;

  copyable.forEach((el) => {
    const text = el.textContent?.trim() ?? "";
    el.classList.add("browx-copyable");
    el.title = "Click to copy";
    if (focusCount <= FOCUS_LIMIT && focusable(el, text)) {
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        void copy(el);
      });
    }
    el.addEventListener("click", () => {
      const picked = window.getSelection()?.toString().trim();
      if (!picked || picked === text) void copy(el);
    });
  });

  // The accessible name of a scrollable table is its nearest preceding heading, so
  // a screen reader lists "Environment variables table" and not N identical stops.
  // A second table under the same heading gets "(2 of 2)" style numbering.
  // One pass in document order pairs each table with its nearest preceding heading.
  const tables: HTMLElement[] = [];
  const headingOf = new Map<HTMLElement, HTMLElement | undefined>();
  let lastHeading: HTMLElement | undefined;
  document
    .querySelectorAll<HTMLElement>(".sl-markdown-content :is(h1, h2, h3, h4, h5, h6, table)")
    .forEach((el) => {
      if (el.tagName === "TABLE") {
        tables.push(el);
        headingOf.set(el, lastHeading);
      } else lastHeading = el;
    });
  const labels = new Map<HTMLElement, string>();
  const byHeading = new Map<HTMLElement | undefined, HTMLElement[]>();
  for (const table of tables) {
    const h = headingOf.get(table);
    byHeading.set(h, [...(byHeading.get(h) ?? []), table]);
  }
  byHeading.forEach((group, h) => {
    const base = h?.textContent?.trim();
    group.forEach((table, i) => {
      if (!base) return labels.set(table, "Scrollable table");
      const n = group.length > 1 ? ` (${i + 1} of ${group.length})` : "";
      labels.set(table, `${base} table${n}`);
    });
  });

  tables.forEach((table) => {
    new ResizeObserver(() => {
      const scrolls = table.scrollWidth > table.clientWidth + 1;
      // No role override: the table keeps its table semantics.
      for (const [name, value] of [
        ["tabindex", "0"],
        ["aria-label", labels.get(table) ?? "Scrollable table"],
      ]) {
        if (scrolls) table.setAttribute(name, value);
        else table.removeAttribute(name);
      }
    }).observe(table);
  });
};

// Idle, with a timeout so a busy page still gets the enhancements. Safari has no
// requestIdleCallback.
if ("requestIdleCallback" in window) window.requestIdleCallback(enhance, { timeout: 2000 });
else window.setTimeout(enhance, 200);
