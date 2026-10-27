/* global document, window, NodeFilter, getComputedStyle -- these run inside page.evaluate, in the browser. */
// Compact element dump for one page at 1440px: one line per rule 58 hit, three lines for line-length.
// Usage: node element-dump.mjs <puppeteer-dir> <chrome-wrapper> <url> <hallmark-json> <impeccable-1440-json>
// Chrome starts through the fenced wrapper only; the page is on loopback. Prints nothing when neither rule fired.
// Rule 58: the 3 densest blocks in the 900px from the flagged y (words, last 3 elements of the chain, nearest heading).
// line-length: the 3 widest rendered lines. Character rects are grouped by block ancestor and top coordinate.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [pptDir, chrome, url, hmFile, impFile] = process.argv.slice(2);
if (!pptDir || !chrome || !url || !hmFile || !impFile) {
  console.error(
    "usage: element-dump.mjs <puppeteer-dir> <chrome-wrapper> <url> <hallmark-json> <impeccable-json>",
  );
  process.exit(2);
}
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
let hm;
try {
  hm = JSON.parse(read(hmFile));
} catch {
  hm = {};
}
const ys = (hm.findings ?? [])
  .filter((f) => String(f.gate) === "58")
  .map((f) => Number(/from y=(\d+)/.exec(f.evidence ?? "")?.[1]))
  .filter((y) => Number.isFinite(y));
const wantLines = read(impFile).includes("line-length");
if (ys.length === 0 && !wantLines) process.exit(0);

const puppeteer = createRequire(join(resolve(pptDir), "x.js"))("puppeteer-core");

// Both probes run in the page and return plain strings.
const probeBlocks = (y) => {
  const chain = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 3; n = n.parentElement) {
      const cls = String(n.getAttribute("class") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 1)
        .join(".");
      parts.unshift(n.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
    }
    return parts.join(">");
  };
  const heading = (el) => {
    let last = null;
    for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      if (h.compareDocumentPosition(el) & 4 || h.contains(el)) last = h;
      else break;
    }
    return last ? last.textContent.trim().slice(0, 40) : "none";
  };
  const blocks = [];
  for (const el of document.querySelectorAll(
    "p,li,td,th,dd,dt,pre,figcaption,blockquote,summary",
  )) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || el.querySelector("p,li,td,pre,dd"))
      continue;
    const top = el.getBoundingClientRect().top + window.scrollY;
    if (top < y - 20 || top > y + 900) continue;
    blocks.push({ w: (el.innerText ?? "").split(/\s+/).filter(Boolean).length, el });
  }
  blocks.sort((a, b) => b.w - a.w);
  return blocks
    .slice(0, 3)
    .map((b) => `${b.w}w ${chain(b.el)} [${heading(b.el)}]`)
    .join(" ; ");
};

const probeLines = () => {
  const isInline = (el) => /^inline/.test(getComputedStyle(el).display);
  const block = (el) => {
    let n = el;
    while (n.parentElement && isInline(n)) n = n.parentElement; // cap: tree depth
    return n;
  };
  const lines = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const owners = new Map();
  const ids = new Map();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    if (!owners.has(el)) owners.set(el, block(el));
    const b = owners.get(el);
    const text = node.textContent;
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (!r || r.width === 0) continue;
      if (!ids.has(b)) ids.set(b, ids.size);
      const id = ids.get(b);
      const key = `${id}|${Math.round((r.top + window.scrollY) / 4)}`;
      const l = lines.get(key) ?? { b, chars: 0, top: r.top + window.scrollY };
      l.chars += 1;
      lines.set(key, l);
    }
  }
  const name = (el) => {
    const cls = String(el.getAttribute("class") ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)[0];
    return el.tagName.toLowerCase() + (cls ? `.${cls}` : "");
  };
  return [...lines.values()]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 3)
    .map(
      (l) => `${l.chars}ch ${name(l.b.parentElement ?? l.b)}>${name(l.b)} y=${Math.round(l.top)}`,
    )
    .join(" ; ");
};

const slug = new URL(url).pathname.replace(/^\/|\/$/g, "").replace(/[/.]/g, "_") || "home";
const browser = await puppeteer.launch({ executablePath: resolve(chrome), headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
  const out = [];
  for (const y of ys) out.push(`[dump58] ${slug} y=${y}: ${await page.evaluate(probeBlocks, y)}`);
  if (wantLines) out.push(`[dumpLL] ${slug}: ${await page.evaluate(probeLines)}`);
  console.log(out.join("\n"));
} finally {
  await browser.close();
}
