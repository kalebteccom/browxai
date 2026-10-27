#!/usr/bin/env node
/* global document, window, getComputedStyle, requestAnimationFrame, NodeFilter, CSS, scrollY -- these run inside page.evaluate, in the browser. */
// Layout check for the built browxai.com site. Loads each page at a matrix of
// viewport sizes, themes and states in headless Chromium and prints every
// failing selector with the measured numbers. Exits 1 on any failure that is
// not covered by the allowlist file.
//
//   node scripts/check-layout.mjs http://127.0.0.1:4411
//   node scripts/check-layout.mjs http://127.0.0.1:4411 --json /tmp/out.json
//   node scripts/check-layout.mjs http://127.0.0.1:4411 --pages /,/getting-started/
//
// Serve website/dist first (any static server). Checks, per page and viewport:
//   centering   icon in button, flex rows, centred text, centred landing boxes (1 px)
//   insets      equal left and right padding, equal left and right header gap (1 px)
//   overflow    document scroll, elements past the viewport, text overflowing its
//               box, clipped boxes, key elements covered at their corners,
//               headings hidden under the sticky header after an anchor jump
//   tap-target  interactive elements at least 44 px on phone-sized viewports
//   stability   top and height of the theme control and status lines across themes
//               and after a copy click (1 px)
//   safe-area   env(safe-area-inset-*) used by fixed or sticky edge elements
//   decoration  gradient, backdrop-filter, blur filter or box-shadow on the site's
//               own components and on html and body (and their pseudo-elements)
//   transition  a running transition on anything but transform and opacity
//   tap-target  also at every viewport, 44 px on the hand-built controls
// States: the page, the mobile nav open, the search dialog open, 150% root font
// size, and a 60-character unbroken string injected into a heading, a table
// cell and a button label.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOW = resolve(HERE, "check-layout-allow.json");

const PAGES = [
  "/",
  "/getting-started/",
  "/reference/tool-reference/",
  "/reference/faq/",
  "/guides/configuration/",
  "/guides/recipes/",
  "/guides/sites-behind-bot-protection/",
  "/security/threat-model/",
  "/security/best-practices/",
  "/concepts/capabilities-and-safety/",
  "/plugins/overview/",
  "/404.html",
];
// Pages that also get the mobile-nav-open and search-dialog-open states.
const STATE_PAGES = new Set(["/", "/getting-started/", "/reference/tool-reference/"]);

const vp = (w, h) => ({ w, h, o: w >= h ? "landscape" : "portrait" });
// Phone and tablet viewports run in a touch context (isMobile, hasTouch), so
// the pointer: coarse rules apply. Desktop viewports run in a plain context.
const TOUCH = [
  vp(320, 640),
  vp(360, 800),
  vp(390, 844),
  vp(430, 932),
  vp(768, 1024),
  vp(844, 390),
  vp(800, 360),
];
const DESKTOP = [vp(1024, 768), vp(1280, 800), vp(1920, 1080)];
// Narrower matrix for the more expensive states.
const SUBSET = new Set(["320x640", "390x844", "768x1024", "844x390", "1280x800"]);
const key = (v) => `${v.w}x${v.h}`;
const THEMES = ["light", "dark"];
const STRESS = "Wi".repeat(30);
const TAP_MIN = 44;
const TOL = 1;

function parseArgs(argv) {
  const o = {
    base: null,
    json: null,
    allow: DEFAULT_ALLOW,
    pages: PAGES,
    workers: Math.min(8, availableParallelism()),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = argv[++i];
    else if (a === "--allow") o.allow = argv[++i];
    else if (a === "--no-allow") o.allow = null;
    else if (a === "--pages") o.pages = argv[++i].split(",");
    else if (a === "--workers") o.workers = Number(argv[++i]);
    else if (!a.startsWith("--") && !o.base) o.base = a.replace(/\/$/, "");
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!o.base) {
    console.error(
      "usage: check-layout.mjs <baseUrl> [--pages a,b] [--json file] [--allow file|--no-allow]",
    );
    process.exit(2);
  }
  return o;
}

// ---- Page-side audit (serialised into the browser, no outer scope) ---------

async function audit({ theme, phone, scenario, tapMin, tol }) {
  const de = document.documentElement;
  de.dataset.theme = theme;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = [];
  const cw = de.clientWidth;
  const ch = de.clientHeight;
  const n1 = (x) => Math.round(x * 10) / 10;

  const sel = (el) => {
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 4 && n !== document.body; i++) {
      let s = n.localName;
      if (n.id) {
        parts.unshift(`${s}#${CSS.escape(n.id)}`);
        break;
      }
      const cls = [...n.classList].filter((c) => !/^astro-|^sl-/.test(c)).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(" > ");
  };
  const add = (check, el, detail, extra) => out.push({ check, sel: sel(el), detail, ...extra });
  const cs = (el) => getComputedStyle(el);
  const rect = (el) => el.getBoundingClientRect();
  const skipTag = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|LINK|META|OPTION|HEAD|TITLE)$/;

  const root = scenario === "search" ? document.querySelector("dialog[open]") : document.body;
  if (!root) {
    add("state", de, "search dialog did not open", { lv: "blocker" });
    return out;
  }
  const visible = (el) => {
    if (skipTag.test(el.tagName)) return false;
    const r = rect(el);
    if (r.width <= 1 || r.height <= 1) return false;
    return el.checkVisibility({ checkVisibilityCSS: true });
  };
  const all = [...root.querySelectorAll("*")].filter(
    (el) => visible(el) && (el.localName === "svg" || !el.closest("svg")),
  );
  const hasText = (el) =>
    [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 0);
  const labelText = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let t = "";
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (!n.textContent.trim() || !p || p.closest("svg,.sr-only,.browx-sr-only")) continue;
      if (rect(p).width > 1 && p.checkVisibility({ checkVisibilityCSS: true })) t += n.textContent;
    }
    return t.trim();
  };
  const clippedByAncestor = (el) => {
    for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
      if (cs(a).overflowX !== "visible" && cs(el).position !== "fixed") return true;
    }
    return false;
  };

  // ---- overflow: document scroll and elements past the viewport ----
  if (scenario === "page" || scenario === "nav") {
    if (de.scrollWidth > cw + tol)
      add("doc-scroll", de, `scrollWidth=${de.scrollWidth} clientWidth=${cw}`, { lv: "blocker" });
  }
  const off = new Set();
  for (const el of all) {
    if (el.closest(".sr-only,.sl-skip-link")) continue;
    if (clippedByAncestor(el)) continue;
    const r = rect(el);
    if (r.right > cw + tol || r.left < -tol) {
      if (off.has(el.parentElement)) {
        off.add(el);
        continue;
      }
      off.add(el);
      add("offscreen", el, `left=${n1(r.left)} right=${n1(r.right)} viewport=${cw}`, {
        lv: "blocker",
      });
    }
  }

  // ---- overflow: text spilling out of, or clipped by, its own box ----
  for (const el of all) {
    const s = cs(el);
    if (s.display === "inline") continue;
    const ox = el.scrollWidth - el.clientWidth;
    if (ox > tol && s.overflowX === "visible" && hasText(el))
      add("text-overflow", el, `scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`, {
        lv: "should",
      });
    else if (ox > tol && (s.overflowX === "hidden" || s.overflowX === "clip"))
      add("clipped", el, `scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`, {
        lv: "should",
      });
    const oy = el.scrollHeight - el.clientHeight;
    if (oy > tol && (s.overflowY === "hidden" || s.overflowY === "clip"))
      add("clipped", el, `scrollHeight=${el.scrollHeight} clientHeight=${el.clientHeight}`, {
        lv: "should",
      });
  }

  // ---- overflow: key elements covered at their corners ----
  const keySel =
    "header.header,.browx-btn,.browx-copy,h1,site-search button,starlight-menu-button button," +
    "starlight-theme-select select,.browx-card,.browx-window,dialog[open] input,dialog[open] .dialog-frame";
  for (const el of root.querySelectorAll(keySel)) {
    if (!visible(el)) continue;
    const r = rect(el);
    if (r.left < 0 || r.top < 0 || r.right > cw || r.bottom > ch) continue;
    const rad = Math.min(parseFloat(cs(el).borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
    const i = rad * 0.3 + 2;
    for (const [x, y] of [
      [r.left + i, r.top + i],
      [r.right - i, r.top + i],
      [r.left + i, r.bottom - i],
      [r.right - i, r.bottom - i],
    ]) {
      const top = document.elementFromPoint(x, y);
      // A control inside the same component (clear button in a search field) or the open nav overlay is not a defect.
      if (scenario === "nav" && el.matches("h1")) break;
      if (
        top &&
        !el.contains(top) &&
        !top.contains(el) &&
        top.closest("form") !== el.closest("form")
      ) {
        add("covered", el, `point=${n1(x)},${n1(y)} covered by ${sel(top)}`, { lv: "blocker" });
        break;
      }
    }
  }

  // ---- tap targets ----
  if (phone) {
    const interactive =
      'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])';
    for (const el of all) {
      if (!el.matches(interactive) || el.closest(".sr-only,.sl-skip-link,.sl-anchor-link"))
        continue;
      const s = cs(el);
      let inlineInProse = false;
      if (s.display === "inline") {
        const own = el.textContent.trim().length;
        const par = el.parentElement ? el.parentElement.textContent.trim().length : 0;
        inlineInProse = par > own + 2;
        if (inlineInProse && el.localName === "a") continue; // link inside a sentence
      }
      const r = rect(el);
      if (r.height < tapMin - tol || r.width < tapMin - tol)
        add("tap-target", el, `w=${n1(r.width)} h=${n1(r.height)} min=${tapMin}`, {
          lv: r.height < tapMin - tol && !inlineInProse ? "should" : "nit",
        });
    }
  }

  // ---- decoration and motion on the site's own components ----
  // Vendor chrome (Starlight, Pagefind, code blocks) is out of scope; the logo
  // keeps its own colours, so anything named logo is skipped.
  const ownSel = '[class*="browx-"],.bx-step,.bx-hub,#starlight__sidebar a';
  const ownEls = [de, document.body, ...all.filter((el) => el.matches(ownSel))].filter(
    (el) => !el.closest('[class*="logo"],.site-title img'),
  );
  for (const el of ownEls) {
    for (const pseudo of [null, "::before", "::after"]) {
      const s = pseudo ? getComputedStyle(el, pseudo) : cs(el);
      if (pseudo && s.content === "none") continue;
      const where = pseudo ? `${sel(el)}${pseudo}` : sel(el);
      const bad = [];
      if (/gradient\(/.test(s.backgroundImage) || /gradient\(/.test(s.maskImage || ""))
        bad.push("gradient");
      if (s.backdropFilter && s.backdropFilter !== "none")
        bad.push(`backdrop-filter ${s.backdropFilter}`);
      if (/blur\(/.test(s.filter)) bad.push(`filter ${s.filter}`);
      if (el.matches(ownSel) && s.boxShadow !== "none") bad.push(`box-shadow ${s.boxShadow}`);
      if (bad.length)
        out.push({ check: "decoration", sel: where, detail: bad.join("; "), lv: "should" });
      const props = s.transitionProperty.split(",").map((x) => x.trim());
      const durs = s.transitionDuration.split(",").map((x) => parseFloat(x));
      const layout = props.filter(
        (p, i) => durs[i % durs.length] > 0 && !["transform", "opacity", "none"].includes(p),
      );
      if (layout.length)
        out.push({
          check: "transition",
          sel: where,
          detail: `transition on ${layout.join(", ")}`,
          lv: "should",
        });
    }
  }
  // The hand-built controls reach 44 px at every viewport, not only on phones.
  if (!phone) {
    const controls =
      ".browx-btn,.browx-copy,.browx-sidebar-llms,.browx-credit a,.browx-facts a,.browx-topnav a,#starlight__sidebar .top-level a";
    for (const el of all) {
      if (!el.matches(controls)) continue;
      const r = rect(el);
      if (r.height < tapMin - tol)
        add("tap-target", el, `w=${n1(r.width)} h=${n1(r.height)} min=${tapMin}`, { lv: "should" });
    }
  }

  // ---- centering: icon in button ----
  const iconHosts =
    'button,[role="button"],a.browx-btn,.social-icons a,starlight-theme-select label,summary';
  for (const el of all) {
    if (!el.matches(iconHosts)) continue;
    const icons = [...el.querySelectorAll("svg,img")].filter(visible);
    if (!icons.length) continue;
    const pr = rect(el);
    const iconOnly = labelText(el) === "";
    for (const ic of icons) {
      const r = rect(ic);
      const dy = r.top + r.height / 2 - (pr.top + pr.height / 2);
      const dx = r.left + r.width / 2 - (pr.left + pr.width / 2);
      // The theme select pairs a start icon with an end caret, so only the vertical axis applies.
      const horizontal = iconOnly && !el.matches("starlight-theme-select label");
      if (Math.abs(dy) > tol || (horizontal && Math.abs(dx) > tol))
        add("center-icon", el, `icon=${sel(ic)} dy=${n1(dy)} dx=${n1(dx)} iconOnly=${iconOnly}`, {
          lv: "should",
        });
    }
  }

  // ---- centering: single-line flex rows with align-items:center ----
  for (const el of all) {
    const s = cs(el);
    if (!/flex/.test(s.display) || s.alignItems !== "center" || !s.flexDirection.startsWith("row"))
      continue;
    const kids = [...el.children].filter(
      (k) => visible(k) && cs(k).position !== "absolute" && cs(k).position !== "fixed",
    );
    if (kids.length < 2) continue;
    const rects = kids.map(rect);
    const tallest = Math.max(...rects.map((r) => r.height));
    const pr = rect(el);
    const bt = parseFloat(s.borderTopWidth);
    const pt = parseFloat(s.paddingTop);
    const ph = pr.height - pt - parseFloat(s.paddingBottom) - bt - parseFloat(s.borderBottomWidth);
    if (s.flexWrap !== "nowrap" && ph > tallest * 1.6) continue; // wrapped onto several lines
    const pcy = pr.top + bt + pt + ph / 2;
    kids.forEach((k, idx) => {
      const as = cs(k).alignSelf;
      if (as !== "auto" && as !== "center") return;
      const dy = rects[idx].top + rects[idx].height / 2 - pcy;
      if (Math.abs(dy) > tol)
        add("center-row", k, `parent=${sel(el)} dy=${n1(dy)}`, { lv: "should" });
    });
  }

  // ---- centering: text-align:center blocks ----
  for (const el of all) {
    const s = cs(el);
    if (s.textAlign !== "center" || s.display === "inline" || !hasText(el)) continue;
    if ([...el.children].some((c) => !/^inline/.test(cs(c).display))) continue;
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const rs = [...rg.getClientRects()].filter((q) => q.width > 0);
    if (!rs.length) continue;
    const ul = Math.min(...rs.map((q) => q.left));
    const ur = Math.max(...rs.map((q) => q.right));
    const r = rect(el);
    const cl = r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
    const cr = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
    if (cr - cl < 5) continue;
    const d = (ul + ur) / 2 - (cl + cr) / 2;
    if (Math.abs(d) > tol)
      add("center-text", el, `dx=${n1(d)} text=${n1(ul)}..${n1(ur)} box=${n1(cl)}..${n1(cr)}`, {
        lv: "should",
      });
  }

  // ---- centering on the landing page (no sidebar) ----
  if (document.querySelector(".browx-hero") && scenario !== "search") {
    const boxes =
      ".browx-hero,.browx-diagram,.browx-section,.browx-shots,.browx-shot,.browx-shot-step,.browx-facts,.browx-posture";
    for (const el of document.querySelectorAll(boxes)) {
      if (!visible(el)) continue;
      const r = rect(el);
      const l = r.left;
      const rt = cw - r.right;
      if (Math.abs(l - rt) > tol)
        add("center-box", el, `left=${n1(l)} right=${n1(rt)}`, { lv: "should" });
    }
  }

  // ---- equal insets: left and right padding of containers ----
  const padSel =
    ".header,.browx-credit,footer,.browx-card,.browx-window,.browx-window-bar,.content-panel,.sl-container,.pagination-links a,.browx-btn,.browx-copy,.browx-install,dialog .dialog-frame,.browx-posture-zone,.browx-cap";
  for (const el of root.querySelectorAll(padSel)) {
    if (!visible(el)) continue;
    const s = cs(el);
    const pl = parseFloat(s.paddingLeft);
    const pr2 = parseFloat(s.paddingRight);
    if (Math.abs(pl - pr2) > tol)
      add("inset-pad", el, `padLeft=${n1(pl)} padRight=${n1(pr2)}`, { lv: "should" });
  }
  const header = document.querySelector("header.header");
  if (header && scenario !== "search") {
    const kids = [...header.children].filter(visible);
    if (kids.length) {
      const l = Math.min(...kids.map((k) => rect(k).left));
      const rt = cw - Math.max(...kids.map((k) => rect(k).right));
      if (Math.abs(l - rt) > tol)
        add("inset-gap", header, `left=${n1(l)} right=${n1(rt)}`, { lv: "should" });
    }
  }

  // ---- page-level: anchors under the sticky header, safe-area ----
  if (scenario === "page") {
    let topInset = 0;
    const edge = [];
    for (const el of document.body.querySelectorAll("*")) {
      const p = cs(el).position;
      if (p !== "fixed" && p !== "sticky") continue;
      if (!visible(el)) continue;
      const r = rect(el);
      if (r.width < cw * 0.5 || r.height > ch * 0.4) continue;
      if (r.top <= 1 && r.bottom > 0) topInset = Math.max(topInset, r.bottom);
      if (r.top <= 1 || r.bottom >= ch - 1) edge.push(el);
    }
    const heads = [...document.querySelectorAll("main h2[id],main h3[id]")];
    const pick = [heads[0], heads[Math.floor(heads.length / 2)], heads[heads.length - 1]].filter(
      (h, i, a) => h && a.indexOf(h) === i,
    );
    const prevBehavior = de.style.scrollBehavior;
    de.style.scrollBehavior = "auto";
    for (const h of pick) {
      h.scrollIntoView({ block: "start" });
      const t = rect(h).top;
      if (t < topInset - tol && window.scrollY + ch < de.scrollHeight - 2)
        add("anchor-covered", h, `headingTop=${n1(t)} stickyBottom=${n1(topInset)}`, {
          lv: "should",
        });
    }
    window.scrollTo(0, 0);
    de.style.scrollBehavior = prevBehavior;

    let usesEnv = false;
    for (const sh of document.styleSheets) {
      try {
        for (const rule of sh.cssRules)
          if (rule.cssText.includes("safe-area-inset")) usesEnv = true;
      } catch {
        // cross-origin sheet
      }
    }
    const cover = /viewport-fit=cover/.test(
      document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
    );
    // Without viewport-fit=cover the browser insets the page itself, so env() is only needed with it.
    if (edge.length && cover && !usesEnv)
      add(
        "safe-area",
        edge[0],
        `${edge.length} fixed or sticky edge element(s), viewport-fit=cover, no env(safe-area-inset-*) in any stylesheet`,
        { lv: "should" },
      );
  }
  return out;
}

// ---- Runner ----------------------------------------------------------------

async function runJob(browser, base, path, kind) {
  const touch = kind === "touch";
  const ctx = await browser.newContext(
    touch
      ? {
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
        }
      : { viewport: { width: 1280, height: 800 } },
  );
  const page = await ctx.newPage();
  const hits = [];
  const vps = touch ? TOUCH : DESKTOP;
  const load = async () => {
    await page.goto(base + path, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
  };
  const measure = async (v, theme, variant, scenario) => {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.emulateMedia({ colorScheme: theme });
    const res = await page.evaluate(audit, {
      theme,
      phone: Math.min(v.w, v.h) <= 430,
      scenario,
      tapMin: TAP_MIN,
      tol: TOL,
    });
    for (const h of res) {
      let lv = h.lv ?? "should";
      if (variant === "stress") lv = h.check === "doc-scroll" ? "should" : "nit";
      hits.push({ ...h, lv, page: path, vp: key(v), orient: v.o, theme, variant, scenario });
    }
  };

  // Bounding box (top and height) of the theme control and of every status line.
  const boxes = (state) =>
    page.evaluate((st) => {
      const out = [];
      const q = [
        ["theme-control", "starlight-theme-select"],
        ["status-line", "[role='status']"],
      ];
      for (const [name, css] of q)
        document.querySelectorAll(css).forEach((el, i) => {
          const r = el.getBoundingClientRect();
          if (name === "theme-control" && (r.width <= 1 || !el.checkVisibility())) return;
          out.push({
            id: `${name}#${i}`,
            top: Math.round((name === "status-line" ? r.top + scrollY : r.top) * 10) / 10,
            height: Math.round(r.height * 10) / 10,
            st,
          });
        });
      return out;
    }, state);
  const stable = async (v, states) => {
    const base = new Map();
    for (const [label, fn] of states) {
      await fn();
      for (const b of await boxes(label)) {
        const first = base.get(b.id);
        if (!first) base.set(b.id, b);
        else if (Math.abs(first.top - b.top) > TOL || Math.abs(first.height - b.height) > TOL)
          hits.push({
            check: "stability",
            sel: b.id,
            detail: `${first.st}: top=${first.top} height=${first.height}; ${b.st}: top=${b.top} height=${b.height}`,
            lv: "should",
            page: path,
            vp: key(v),
            orient: v.o,
            theme: "-",
            variant: "base",
            scenario: "page",
          });
      }
    }
  };

  await load();
  for (const v of vps) {
    for (const t of THEMES) await measure(v, t, "base", "page");
    await page.setViewportSize({ width: v.w, height: v.h });
    const setTheme = (t) => async () => {
      await page.emulateMedia({ colorScheme: t });
      await page.evaluate((x) => {
        document.documentElement.dataset.theme = x;
      }, t);
      await page.waitForTimeout(60);
    };
    const states = [
      ["light", setTheme("light")],
      ["dark", setTheme("dark")],
      ["light again", setTheme("light")],
    ];
    if (await page.$(".browx-copy button, button.browx-copy")) {
      states.push([
        "after copy click",
        async () => {
          await page
            .click(".browx-copy button, button.browx-copy", { timeout: 2000 })
            .catch(() => {});
          await page.waitForTimeout(150);
        },
      ]);
    }
    if (SUBSET.has(key(v))) await stable(v, states);
  }

  if (STATE_PAGES.has(path)) {
    for (const v of vps.filter((q) => q.w < 800)) {
      await page.setViewportSize({ width: v.w, height: v.h });
      await load();
      if (!(await page.$("nav.sidebar > button"))) continue;
      await page.click("nav.sidebar > button", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(150);
      for (const t of THEMES) await measure(v, t, "base", "nav");
    }
    for (const v of vps) {
      await page.setViewportSize({ width: v.w, height: v.h });
      await load();
      await page.click("site-search button[data-open-modal]", { timeout: 3000 }).catch(() => {});
      await page
        .waitForSelector("dialog[open] input", { state: "visible", timeout: 3000 })
        .catch(() => {});
      await page.fill("dialog[open] input", "agent").catch(() => {});
      await page.waitForTimeout(500);
      for (const t of THEMES) await measure(v, t, "base", "search");
    }
  }

  await load();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "150%";
  });
  for (const v of vps.filter((q) => SUBSET.has(key(q)))) await measure(v, "dark", "large", "page");

  await load();
  await page.evaluate((s) => {
    const heading = document.querySelector("main h2, main h1, .sl-markdown-content h2");
    if (heading) heading.append(` ${s}`);
    const cell = document.querySelector("main td");
    if (cell) cell.append(` ${s}`);
    for (const b of document.querySelectorAll(
      "a.browx-btn, .browx-copy .lbl-idle, site-search button[data-open-modal] > span:not(.sr-only)",
    ))
      b.append(` ${s}`);
  }, STRESS);
  for (const v of vps.filter((q) => SUBSET.has(key(q)))) await measure(v, "dark", "stress", "page");

  await ctx.close();
  return hits;
}

function loadAllow(file) {
  if (!file || !existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8"));
}
const allowed = (allow, h) =>
  allow.some(
    (a) =>
      (a.check === "*" || a.check === h.check) &&
      (!a.page || a.page === "*" || a.page === h.page) &&
      (!a.selector || h.sel.includes(a.selector)) &&
      (!a.variant || a.variant === h.variant),
  );

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const browser = await chromium.launch().catch((e) => {
    console.error(
      `could not launch Chromium (${e.message.split("\n")[0]}). Run: pnpm install-browser`,
    );
    process.exit(2);
  });
  const jobs = opts.pages.flatMap((p) => [
    [p, "touch"],
    [p, "desktop"],
  ]);
  const all = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: opts.workers }, async () => {
      while (next < jobs.length) {
        const [p, kind] = jobs[next++];
        try {
          all.push(...(await runJob(browser, opts.base, p, kind)));
        } catch (e) {
          all.push({
            check: "runner",
            sel: `${p} (${kind})`,
            detail: e.message.split("\n")[0],
            lv: "blocker",
            page: p,
            vp: "-",
            orient: "-",
            theme: "-",
            variant: "-",
            scenario: "-",
          });
        }
      }
    }),
  );
  await browser.close();

  const allow = loadAllow(opts.allow);
  const failing = all.filter((h) => !allowed(allow, h));
  const groups = new Map();
  for (const h of failing) {
    const k = `${h.check}|${h.page}|${h.sel}`;
    if (!groups.has(k)) groups.set(k, { ...h, cfgs: [] });
    groups
      .get(k)
      .cfgs.push(`${h.vp} ${h.orient[0]} ${h.theme} ${h.variant}/${h.scenario}: ${h.detail}`);
  }
  const order = { blocker: 0, should: 1, nit: 2 };
  const list = [...groups.values()].sort(
    (a, b) =>
      order[a.lv] - order[b.lv] || a.check.localeCompare(b.check) || a.page.localeCompare(b.page),
  );
  for (const g of list) {
    console.log(`FAIL [${g.lv}] ${g.check} ${g.page} ${g.sel}`);
    for (const c of g.cfgs.slice(0, 3)) console.log(`       ${c}`);
    if (g.cfgs.length > 3) console.log(`       (+${g.cfgs.length - 3} more)`);
  }
  if (opts.json)
    writeFileSync(
      opts.json,
      JSON.stringify({ hits: failing, allowedCount: all.length - failing.length }, null, 1),
    );
  const counts = { blocker: 0, should: 0, nit: 0 };
  for (const g of list) counts[g.lv]++;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `${list.length} failing selector group(s) (blocker ${counts.blocker}, should ${counts.should}, nit ${counts.nit}), ` +
      `${all.length - failing.length} allowlisted hit(s), ${jobs.length} page runs, ${secs}s`,
  );
  process.exit(list.length ? 1 : 0);
}

main();
