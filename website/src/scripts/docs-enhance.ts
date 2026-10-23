// Progressive enhancement for docs pages. Without JS the page reads the same.
// 1. Inline code that holds a command or a BROWX_* name copies on click, Enter or
//    Space. The "Copied" bubble is a ::after (see brand.css), so nothing reflows.
// 2. A table that scrolls sideways becomes focusable, so a keyboard can scroll it.
const COMMAND = /^(?:(?:browxai|npx|pnpm) \S|BROWX_[A-Z0-9_]+$)/;
const SKIP = "a, pre, summary, h1, h2, h3, h4, h5, h6, .not-content";

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
  if (!COMMAND.test(text) || el.closest(SKIP)) return;
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

document.querySelectorAll<HTMLElement>(".sl-markdown-content table").forEach((table) => {
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
