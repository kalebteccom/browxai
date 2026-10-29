// Split of docs/tool-reference.md into the published section pages.
//
// docs/tool-reference.md stays the one canonical file (code, tests and AGENTS.md
// point at it). On the site it is too heavy as a single page, so sync-docs.mjs
// cuts it into the pages listed here:
//
//   /reference/tool-reference/            index: the intro, a list of the
//                                         pages below, and the stability policy
//   /reference/tool-reference/<slug>/     one page per entry in toolReferencePages
//
// Each page runs from its `from` heading up to the next page's `from` heading.
// Whatever comes before the first page (the H1, the intro quote and the
// "Stability and semver" section) belongs to the index. A page that starts at a
// level-3 heading, in the middle of a level-2 section, names that section in
// `continues`; the generator then puts a level-2 heading with that text on top,
// so no page skips a heading level.
//
// The plaintext twin (/reference/tool-reference.md, linked from llms.txt) is
// still the whole file, see src/pages/[...slug].md.ts.
import { transformText, assertNoDashes } from "./doc-pipeline.mjs";

export const INDEX_URL = "/reference/tool-reference/";
export const INDEX_TITLE = "Tool reference";
const STABILITY_HEADING = "## Stability and semver";

// Order matters: it is the order in the source file, the sidebar and the index.
// Sizes are the source markdown per page; the rendered HTML is about 2.4 times that.
export const toolReferencePages = [
  {
    slug: "cli-and-configuration",
    label: "CLI and configuration",
    title: "Tool reference: CLI and configuration",
    description:
      "The browxai sub-commands, the plugin runtime in brief, and every configuration key and environment variable.",
    from: "## Sub-commands (CLI)",
  },
  {
    slug: "sessions",
    label: "Sessions",
    title: "Tool reference: sessions",
    description:
      "Opening, listing and closing sessions: engines, profiles, attach modes, device and viewport options, policies and reset sentinels.",
    from: "## Sessions",
  },
  {
    slug: "read-only-tools",
    label: "Read-only tools",
    title: "Tool reference: read-only tools",
    description:
      "snapshot, find, screenshot, text_search, extract, the verify tools, console and network reads, sampling and inspect.",
    from: "## Read-only tools",
  },
  {
    slug: "read-only-tools-continued",
    label: "Read-only tools, continued",
    title: "Tool reference: read-only tools, continued",
    description:
      "overflow_detect, generate_locator, point_probe, WebSocket and worker tools, eval_js, find_feedback and the recording tools.",
    from: "### `overflow_detect`",
    continues: "Read-only tools, continued",
  },
  {
    slug: "action-tools",
    label: "Action tools",
    title: "Tool reference: action tools",
    description:
      "navigate, click, fill, fill_form, press, shortcut, hover, select, uploads and drops, and the PDF, page, element and DOM exports, downloads and assets.",
    from: "## Action tools",
  },
  {
    slug: "action-tools-continued",
    label: "Action tools, continued",
    title: "Tool reference: action tools, continued",
    description:
      "Storage state, artifacts, choose_option, plan and execute, wait_for, device emulation, scroll, batch, flake_check, ActionResult and session pre-approvals.",
    from: "### Storage-state: three layers",
    continues: "Action tools, continued",
  },
  {
    slug: "advanced-tools",
    label: "Advanced tools",
    title: "Tool reference: advanced tools",
    description:
      "Pointer and touch gestures, route mocking, network and CPU emulation, clock, HAR, video, tracing, heap snapshots, performance audits, act_and_diff and profiles.",
    from: "## Advanced tools: gestures, route mocking, compound observers",
  },
  {
    slug: "gated-capabilities",
    label: "Gated capabilities",
    title: "Tool reference: secrets, credentials, extensions, stealth and captcha",
    description:
      "The off-by-default capabilities secrets, credentials, extensions, stealth and captcha, and the Bluetooth, USB and HID device emulation: tools, inputs and gates.",
    from: "## Secrets registry (capability `secrets`)",
  },
  {
    slug: "canvas-diagnostics-and-native",
    label: "Canvas, diagnostics, native apps",
    title: "Tool reference: canvas, diagnostics, human helper and native apps",
    description:
      "canvas tools, the diagnostics recorder, await_human and the __browx helper, the live view, and the ios-app and android-app engines.",
    from: "## Canvas-app automation (capability `canvas`)",
  },
];

const FENCE = /^\s*(```+|~~~+)/;

/** Source line numbers (0-based) of every heading outside fenced code. */
function headings(lines) {
  const out = [];
  let inFence = false;
  lines.forEach((raw, i) => {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      return;
    }
    const m = !inFence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (m) out.push({ line: i, level: m[1].length, text: m[2], raw });
  });
  return out;
}

/**
 * Heading text as rendered (inline markup removed), then slugged the way
 * github-slugger does it, which is what Astro uses for heading ids. Only used
 * to find which page a `](#fragment)` link now lives on; the ids the site
 * emits are still Astro's own.
 */
export function slugOf(text) {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9]))/g, "");
  return plain
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Cut the raw source into the index part and the page chunks.
 * Throws when a `from` heading is missing or out of order, so a renamed
 * heading in docs/tool-reference.md fails the sync instead of dropping a page.
 */
export function splitToolReference(source) {
  assertNoDashes(source);
  const lines = source.split("\n");
  const marks = headings(lines);
  let prev = -1;
  const starts = toolReferencePages.map((page) => {
    const hit = marks.find((h) => h.raw.trimEnd() === page.from);
    if (!hit) throw new Error(`tool-reference split: heading not found: ${page.from}`);
    if (hit.line <= prev)
      throw new Error(`tool-reference split: heading out of order: ${page.from}`);
    prev = hit.line;
    return hit.line;
  });
  const slice = (a, b) => lines.slice(a, b).join("\n");
  const preamble = slice(0, starts[0]);
  const stabilityAt = preamble.split("\n").findIndex((l) => l.trimEnd() === STABILITY_HEADING);
  if (stabilityAt < 0)
    throw new Error(`tool-reference split: heading not found: ${STABILITY_HEADING}`);
  const intro = preamble.split("\n").slice(0, stabilityAt).join("\n");
  const stability = preamble.split("\n").slice(stabilityAt).join("\n");
  const pages = toolReferencePages.map((page, i) => {
    const body = slice(starts[i], starts[i + 1] ?? lines.length);
    return {
      ...page,
      url: `${INDEX_URL}${page.slug}/`,
      raw: page.continues ? `## ${page.continues}\n\n${body}` : body,
    };
  });
  return { intro, stability, pages, headings: marks };
}

/** Map every heading slug in the source to the URL of the page that now holds it. */
function owners(split, source) {
  const lines = source.split("\n");
  const map = new Map();
  const startLine = (page) => lines.findIndex((l) => l.trimEnd() === page.from);
  const bounds = split.pages.map((p) => ({ url: p.url, at: startLine(p) }));
  const first = bounds[0].at;
  for (const h of split.headings) {
    let url = INDEX_URL;
    if (h.line >= first) for (const b of bounds) if (h.line >= b.at) url = b.url;
    const slug = slugOf(h.text);
    if (map.has(slug))
      throw new Error(
        `tool-reference split: duplicate heading id "${slug}" (second at line ${h.line + 1})`,
      );
    map.set(slug, url);
  }
  return map;
}

/** Point `](#fragment)` links at the page that holds the heading. Fences stay as is. */
function relink(text, ownUrl, ownerOf) {
  let inFence = false;
  return text
    .split("\n")
    .map((raw) => {
      if (FENCE.test(raw)) {
        inFence = !inFence;
        return raw;
      }
      if (inFence) return raw;
      return raw.replace(/\]\(#([^)\s]+)\)/g, (m, frag) => {
        const url = ownerOf.get(frag);
        if (!url) throw new Error(`tool-reference split: link to unknown heading #${frag}`);
        return url === ownUrl ? m : `](${url}#${frag})`;
      });
    })
    .join("\n");
}

const sectionList = (pages) =>
  pages.map((p) => `- [${p.label}](${p.url}): ${p.description}`).join("\n");

/**
 * The generated pages as `{ out, title, description, body }`, `out` being the
 * path under src/content/docs. Bodies are fully transformed (house style,
 * link rewrites) and carry no frontmatter.
 */
export function toolReferenceOutputs(source, { indexOut, indexDescription }) {
  const split = splitToolReference(source);
  const ownerOf = owners(split, source);
  const finish = (raw, url) => transformText(relink(raw, url, ownerOf)).trim() + "\n";
  const indexRaw = [
    split.intro.trimEnd(),
    "",
    "## Sections",
    "",
    "The reference is split by topic. Each section below opens its own page.",
    "",
    sectionList(split.pages),
    "",
    split.stability.trimEnd(),
  ].join("\n");
  const index = {
    out: indexOut,
    title: INDEX_TITLE,
    description: indexDescription,
    body: finish(indexRaw, INDEX_URL),
  };
  const sections = split.pages.map((p) => ({
    out: `reference/tool-reference/${p.slug}.md`,
    title: p.title,
    description: p.description,
    label: p.label,
    body: finish(p.raw, p.url),
  }));
  return [index, ...sections];
}
