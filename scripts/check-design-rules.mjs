#!/usr/bin/env node
// Static design-rule guard (G1) for the docs site. No dependencies, no build.
//
//   no-dash                  em and en dashes (and a spaced hyphen standing in
//                            for one) in user-visible copy: the published docs,
//                            README, llms.txt, site content and components.
//                            Fenced blocks and inline code are skipped.
//   mono-outside-code        a monospace font-family in website/src/styles on a
//                            selector that is not real code.
//   no-uppercase-tracking    text-transform: uppercase or positive
//                            letter-spacing on a selector that is not real code.
//
//   no-gradient-glow        gradient(), backdrop-filter, filter: blur, a box-shadow
//                            or text-shadow in an accent colour, and any
//                            aurora or glow name, outside the logo selectors.
//   no-pure-colour          #fff, #000, white, black, rgb(255 255 255) and
//                            rgba(0,0,0) as paint in site CSS, outside the token
//                            file (brand-tokens.css).
//   hover-without-active    a :hover rule whose selector has no :active twin.
//   layout-transition       a transition on anything but transform and opacity,
//                            or transitions with no prefers-reduced-motion
//                            guard anywhere in the site CSS.
//   flagged-font, tight-leading, measure-range
//                           type guards, see scripts/design-type-rules.mjs.
//   spacing-token           padding, margin or gap that is not a var(--space-*)
//                            token, 0, auto, a percentage or a fluid clamp().
//
// Allowlist: scripts/check-design-rules-allow.json, entries
// { rule, path, count, reason }. A path takes exactly `count` findings of that
// rule; more or fewer fails, so a stale entry cannot hide new ones.
//
// Run: node scripts/check-design-rules.mjs   (exit 1 with one line per finding)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasMeasure, typeFinding } from "./design-type-rules.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SITE = join(ROOT, "website");

// Selectors whose text is real code: code panes, inline code, shell commands.
const CODE_SELECTOR = /(^|[^\w-])(pre|code|kbd|samp)([^\w-]|$)|\.browx-install\b|\.browx-snap\b/;
const MONO_FONT = /mono|--sl-font-code|ui-monospace|courier/i;
const DASH = /[–—]/;
const SPACED_HYPHEN = /\w[)\]`"']? - [\w`("']/;
const FENCE = /^\s*(```+|~~~+)/;
const TEXT_EXT = /\.(md|mdx|astro|txt|json)$/;
const CODE_EXT = /\.(mjs|ts|js)$/;

const findings = [];
const report = (file, line, rule, detail) =>
  findings.push({ path: relative(ROOT, file), line, rule, detail });

const LOGO_SELECTOR = /\blogo\b|\.browx-logo|\.site-logo|favicon/i;
const TOKEN_FILE = /(^|\/)brand-tokens\.css$/;
const ACCENT_NAME = /accent|violet|glow|aurora|pink/i;
const PURE_COLOUR =
  /#(?:f{3}|f{6}|f{8}|0{3}|0{6}|0{8})\b|\b(?:white|black)\b|rgba?\(\s*(?:255[\s,]+255[\s,]+255|0[\s,]+0[\s,]+0)\b/i;
const MOTION_OK = new Set(["transform", "opacity", "none"]);
const SPACING_PROP = /^(?:padding|margin|gap|row-gap|column-gap|grid-gap)(?:-[a-z]+)*$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".astro") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Lines of prose: fenced blocks and inline code removed, numbering kept. */
function* proseLines(text) {
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    yield [i + 1, lines[i].replace(/`[^`]*`/g, "``")];
  }
}

function checkProse(file, { spacedHyphen }) {
  for (const [n, line] of proseLines(readFileSync(file, "utf8"))) {
    if (DASH.test(line)) report(file, n, "no-dash", line.trim().slice(0, 90));
    else if (spacedHyphen && SPACED_HYPHEN.test(line.replace(/^\s*[-*]\s/, ""))) {
      if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(line))
        report(file, n, "no-dash", line.trim().slice(0, 90));
    }
  }
}

/** Source files: only string-ish lines count, comments are skipped. */
function checkSource(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    const code = line.replace(/\s\/\/ .*$/, "");
    if (DASH.test(code)) report(file, i + 1, "no-dash", t.slice(0, 90));
  });
}

const transitionFiles = [];
let motionGuard = false;
let measureCap = false;
const stripComments = (raw) => raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const oneLine = (x) => x.replace(/\s+/g, " ").trim();

/** Why a spacing value is off-token, or "" when it is fine. */
function offToken(value) {
  const stripped = value.replace(/var\(--space-[\w-]+\)/g, "").replace(/!important/, "");
  if (/(clamp|min|max)\(/.test(stripped) && /\d(vw|vh|dvh|cqi|%)/.test(stripped)) return "";
  const bad = (stripped.match(/-?\d*\.?\d+[a-z%]+/g) || []).filter((n) => parseFloat(n) !== 0);
  return bad.filter((n) => !n.endsWith("%")).join(" ");
}

/** The selector with its :hover, :focus-visible and :active parts removed. */
const stateKey = (sel) =>
  oneLine(
    sel.replace(
      /:is\(\s*:(?:hover|focus-visible|active)[^)]*\)|:hover|:focus-visible|:active/g,
      "",
    ),
  );

function checkCss(file, raw, isTokenFile = false) {
  const css = stripComments(raw);
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  const hovered = [];
  const pressed = new Set();
  let usesTransition = false;
  let m;
  while ((m = rule.exec(css))) {
    const selector = oneLine(m[1]);
    const line = css.slice(0, m.index + m[0].indexOf("{")).split("\n").length;
    const logo = LOGO_SELECTOR.test(selector);
    if (/@keyframes/.test(selector) && /aurora|glow/i.test(selector) && !logo)
      report(file, line, "no-gradient-glow", `${selector}`);
    if (!logo && /aurora|glow/i.test(selector.replace(/@media[^{]*/g, "")))
      report(file, line, "no-gradient-glow", `${selector} (aurora or glow selector)`);
    for (const part of selector.split(",")) {
      if (/:hover/.test(part)) hovered.push({ key: stateKey(part), line, part: oneLine(part) });
      if (/:active/.test(part)) pressed.add(stateKey(part));
    }
    const code = CODE_SELECTOR.test(selector);
    for (const decl of m[2].split(";")) {
      const [prop, ...rest] = decl.split(":");
      const name = prop.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (!name || !value) continue;
      const at = (rule, detail) =>
        report(file, line, rule, `${selector} { ${name}: ${oneLine(value)} } ${detail}`.trim());
      const typed = typeFinding(selector, name, value, code);
      if (typed) at(typed[0], typed[1]);
      if (!code) {
        if (name === "font-family" && MONO_FONT.test(value)) at("mono-outside-code", "");
        else if (name === "text-transform" && /uppercase/.test(value))
          at("no-uppercase-tracking", "");
        else if (
          name === "letter-spacing" &&
          /^\+?(\d*\.)?\d+(em|rem|px)$/.test(value) &&
          parseFloat(value) > 0
        )
          at("no-uppercase-tracking", "");
      }
      if (!logo) {
        if (/gradient\(/.test(value)) at("no-gradient-glow", "(gradient)");
        if (name === "backdrop-filter" || name === "-webkit-backdrop-filter")
          at("no-gradient-glow", "(backdrop-filter)");
        if (name === "filter" && /blur\(/.test(value)) at("no-gradient-glow", "(blur)");
        if ((name === "box-shadow" || name === "text-shadow") && ACCENT_NAME.test(value))
          at("no-gradient-glow", "(accent shadow)");
        if (name.startsWith("--") && /aurora|glow/i.test(name))
          at("no-gradient-glow", "(aurora or glow token)");
        if (name === "animation" && /aurora|glow/i.test(value))
          at("no-gradient-glow", "(aurora or glow animation)");
      }
      if (!isTokenFile && !/^(--)/.test(name)) {
        const bare = value.replace(/var\([^)]*\)/g, "");
        if (PURE_COLOUR.test(bare)) at("no-pure-colour", "");
      }
      if (name === "transition" || name === "transition-property") {
        usesTransition = true;
        const props =
          name === "transition-property"
            ? value.split(",").map((x) => x.trim())
            : value.split(/,(?![^(]*\))/).map(
                (seg) =>
                  seg
                    .trim()
                    .split(/\s+/)
                    .find((t) => !/^[\d.]+m?s$/.test(t)) || "",
              );
        const bad = props.filter((p) => p && !MOTION_OK.has(p));
        if (bad.length) at("layout-transition", `(${bad.join(", ")}: only transform and opacity)`);
      }
      if (SPACING_PROP.test(name)) {
        const why = offToken(value);
        if (why) at("spacing-token", `(off-token: ${why})`);
      }
    }
  }
  for (const h of hovered)
    if (!pressed.has(h.key))
      report(file, h.line, "hover-without-active", `${h.part} has no :active rule`);
  if (usesTransition) transitionFiles.push(file);
  if (/prefers-reduced-motion\s*:\s*reduce/.test(css)) motionGuard = true;
  if (hasMeasure(css)) measureCap = true;
}

async function publishedDocs() {
  const pipeline = await import(pathToFileURL(join(SITE, "scripts", "doc-pipeline.mjs")).href);
  return [...pipeline.htmlPages, ...pipeline.agentOnlyPages].map((p) => join(pipeline.SRC, p.src));
}

/** Findings as lines, minus the allowlisted ones. A count mismatch is a finding. */
function applyAllowlist(all) {
  const file = join(ROOT, "scripts", "check-design-rules-allow.json");
  const allow = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const lines = [];
  const used = new Set();
  const groups = new Map();
  for (const f of all) {
    const k = `${f.rule}|${f.path}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  for (const [k, list] of groups) {
    const entry = allow.find((a) => `${a.rule}|${a.path}` === k);
    if (entry) used.add(entry);
    if (entry && entry.count === list.length) continue;
    if (entry)
      lines.push(
        `${list[0].path}:1: ${list[0].rule}: allowlist says ${entry.count}, found ${list.length}`,
      );
    for (const f of list) lines.push(`${f.path}:${f.line}: ${f.rule}: ${f.detail}`);
  }
  for (const a of allow)
    if (!used.has(a)) lines.push(`${a.path}:1: ${a.rule}: stale allowlist entry (no findings)`);
  return lines;
}

async function main() {
  // Published docs and README: sentences in markdown.
  for (const file of [...(await publishedDocs()), join(ROOT, "README.md")])
    checkProse(file, { spacedHyphen: true });

  // llms.txt is plain prose.
  checkProse(join(SITE, "public", "llms.txt"), { spacedHyphen: true });

  // Site content, components and config: copy lives in these.
  for (const file of walk(join(SITE, "src"))) {
    if (/\.astro$/.test(file))
      for (const [, block] of readFileSync(file, "utf8").matchAll(
        /<style[^>]*>([\s\S]*?)<\/style>/g,
      ))
        checkCss(file, block);
    if (TEXT_EXT.test(file)) checkProse(file, { spacedHyphen: /\.(md|mdx)$/.test(file) });
    else if (/\.css$/.test(file) && file.includes("styles"))
      checkCss(file, readFileSync(file, "utf8"), TOKEN_FILE.test(file));
    else if (CODE_EXT.test(file)) checkSource(file);
  }
  checkSource(join(SITE, "astro.config.mjs"));
  checkSource(join(SITE, "scripts", "gen-og.mjs"));

  if (!motionGuard)
    for (const f of transitionFiles)
      report(f, 1, "layout-transition", "transition without a prefers-reduced-motion guard");
  if (!measureCap)
    report(
      join(SITE, "src", "styles"),
      1,
      "measure-range",
      "no 70 to 75ch cap on the content column",
    );
  const remaining = applyAllowlist(findings);
  if (remaining.length) {
    console.error(remaining.join("\n"));
    console.error(`\ncheck-design-rules: ${remaining.length} finding(s)`);
    process.exit(1);
  }
  console.log("check-design-rules: ok");
}

await main();
