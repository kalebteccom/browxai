// Print which elements sit behind a hallmark rule 58 finding and an impeccable line-length finding, for one page at 1440px.
// Usage: node element-dump.mjs <puppeteer-dir> <chrome-wrapper> <url> <hallmark-json> <impeccable-1440-json>
// Chrome starts through the fenced wrapper only; the page is on loopback. Prints nothing when neither rule fired.
// Rule 58: the element at x=720 under several points below the flagged y, its closest heading, its tag/class chain, word counts, and the densest blocks in the window.
// line-length: the 5 widest rendered text lines (characters per line, from Range.getClientRects per character).
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

// Runs in the page. Returns plain data only.
const probeRule58 = (y) => {
  const chain = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      const cls = String(n.getAttribute("class") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join(".");
      parts.unshift(n.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
    }
    return parts.join(" > ");
  };
  const words = (el) => (el.innerText ?? "").split(/\s+/).filter(Boolean).length;
  const heading = (el) => {
    let last = null;
    for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      if (
        h === el ||
        h.contains(el) ||
        h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
      )
        last = h;
      else break;
    }
    return last
      ? `${last.tagName.toLowerCase()} "${last.textContent.trim().slice(0, 60)}"`
      : "none";
  };
  const vis = (el) => {
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  };
  const at = [];
  for (const dy of [0, 150, 300, 450, 600]) {
    window.scrollTo(0, Math.max(0, y + dy - 100));
    const el = document.elementFromPoint(720, y + dy - window.scrollY);
    if (!el) {
      at.push(`y=${y + dy}: nothing at x=720`);
      continue;
    }
    const sec = el.closest("section,article,details,li,tr,figure,dl,table") ?? el.parentElement;
    at.push(
      `y=${y + dy}: ${chain(el)} | heading ${heading(el)} | words el ${words(el)}, container <${sec?.tagName.toLowerCase()}> ${sec ? words(sec) : 0}`,
    );
  }
  const blocks = new Map();
  for (const el of document.querySelectorAll(
    "p,li,td,th,dd,dt,pre,figcaption,blockquote,h1,h2,h3,h4,summary",
  )) {
    if (!vis(el) || el.querySelector("p,li,td,pre,dd")) continue;
    const r = el.getBoundingClientRect();
    const top = r.top + window.scrollY;
    if (top < y - 20 || top > y + 900) continue;
    const key = chain(el).split(" > ").slice(-3).join(" > ");
    const b = blocks.get(key) ?? { n: 0, words: 0 };
    b.n += 1;
    b.words += words(el);
    blocks.set(key, b);
  }
  // Words visible in the viewport at this scroll, by landmark: the sidebar and outline count on every screen.
  window.scrollTo(0, y);
  const zones = new Map();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const rg = document.createRange();
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const pe = n.parentElement;
    if (!pe || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(pe.tagName) || !vis(pe)) continue;
    rg.selectNodeContents(n);
    const r = rg.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
    const z =
      pe.closest("header,nav,aside,main,footer,starlight-toc,starlight-menu-button") ??
      document.body;
    const k = chain(z).split(" > ").slice(-2).join(" > ");
    zones.set(k, (zones.get(k) ?? 0) + n.textContent.split(/\s+/).filter(Boolean).length);
  }
  const zoneList = [...zones].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}w in ${k}`);
  const dense = [...blocks].sort((a, b) => b[1].words - a[1].words).slice(0, 8);
  return { at, zones: zoneList, dense: dense.map(([k, v]) => `${v.words}w in ${v.n}x ${k}`) };
};

const probeLines = () => {
  const lines = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    const text = node.textContent;
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (!r || r.width === 0) continue;
      const key = `${Math.round(r.top + window.scrollY)}|${el.tagName}|${el.className}|${Math.round(r.left / 40)}`;
      const l = lines.get(key) ?? {
        el,
        chars: 0,
        left: r.left,
        right: r.right,
        text: "",
        top: r.top + window.scrollY,
      };
      l.chars += 1;
      l.right = Math.max(l.right, r.right);
      l.left = Math.min(l.left, r.left);
      if (l.text.length < 80) l.text += text[i];
      lines.set(key, l);
    }
  }
  const chain = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      const cls = String(n.getAttribute("class") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join(".");
      parts.unshift(n.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
    }
    return parts.join(" > ");
  };
  return [...lines.values()]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5)
    .map(
      (l) =>
        `${l.chars} chars, ${Math.round(l.right - l.left)}px, y=${Math.round(l.top)}: ${chain(l.el)} | "${l.text.trim()}"`,
    );
};

const browser = await puppeteer.launch({ executablePath: resolve(chrome), headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
  const out = [`--- element dump ${url} (1440px)`];
  for (const y of ys) {
    const r = await page.evaluate(probeRule58, y);
    out.push(
      `rule 58 flagged from y=${y}`,
      ...r.at.map((l) => `  at ${l}`),
      "  words in the viewport at y, by landmark:",
      ...r.zones.map((l) => `    ${l}`),
      "  densest blocks in the next 900px:",
      ...r.dense.map((l) => `    ${l}`),
    );
  }
  if (wantLines) {
    out.push("line-length: 5 widest text lines");
    for (const l of await page.evaluate(probeLines)) out.push(`  ${l}`);
  }
  console.log(out.join("\n"));
} finally {
  await browser.close();
}
