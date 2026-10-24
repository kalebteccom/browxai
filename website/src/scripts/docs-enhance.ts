// Progressive enhancement for docs pages. Without JS the page reads the same.
// 1. Inline code that holds a command or a BROWX_* name copies on click, Enter or
//    Space. The "Copied" bubble is a ::after (see brand.css), so nothing reflows.
// 2. A table that scrolls sideways becomes focusable, so a keyboard can scroll it.
//    A table of short cells wraps on phone widths instead (see brand.css).
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

document.querySelectorAll<HTMLElement>(".sl-markdown-content code").forEach((el) => {
  const text = el.textContent?.trim() ?? "";
  if (!COMMAND.test(text) || skipped(el)) return;
  el.classList.add("browx-copyable");
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.title = "Click to copy";
  el.addEventListener("click", () => {
    const picked = window.getSelection()?.toString().trim();
    if (!picked || picked === text) void copy(el);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    void copy(el);
  });
});

// A table wraps its cells on a phone when it has few columns and no long code
// token. Anything wider or code-heavy keeps the sideways scroll.
const wraps = (table: HTMLElement) => {
  const cols = table.querySelectorAll("tr:first-child > :is(th, td)").length;
  let longest = 0;
  table.querySelectorAll("td code, th code").forEach((c) => {
    longest = Math.max(longest, c.textContent?.length ?? 0);
  });
  return cols <= 3 ? longest <= 40 : cols === 4 && longest <= 24;
};

document.querySelectorAll<HTMLElement>(".sl-markdown-content table").forEach((table) => {
  if (wraps(table)) table.dataset.browxWrap = "";
  new ResizeObserver(() => {
    const scrolls = table.scrollWidth > table.clientWidth + 1;
    // No role override: the table keeps its table semantics.
    for (const [name, value] of [
      ["tabindex", "0"],
      ["aria-label", "Scrollable table"],
    ]) {
      if (scrolls) table.setAttribute(name, value);
      else table.removeAttribute(name);
    }
  }).observe(table);
});
