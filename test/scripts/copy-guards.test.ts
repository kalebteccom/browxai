// Proof that the copy guard, the h1 guard and the shared code-span stripper
// fail or pass as documented. Each case plants one violation in a throwaway
// tree and asserts a non-zero exit that names the rule.

import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { cleanTrees, makeTree, REPO, runNode } from "./_guard-tree.js";

afterEach(cleanTrees);

const COPY = "scripts/check-copy-rules.mjs";
const H1 = "website/scripts/check-h1.mjs";
const PAGE = "website/src/content/docs/page.md";
const DOCS = [
  "agent-guidance",
  "plugin-authoring",
  "plugin-governance",
  "plugins-first-party",
  "plugins",
  "security-best-practices-for-adopters",
  "threat-model",
  "tool-reference",
];

function copyFiles(page: string): Record<string, string> {
  const files: Record<string, string> = {
    "README.md": "# browxai\n\nA clean sentence.\n",
    "website/public/llms.txt": "browxai\n",
    "website/src/components/Hero.astro": "<p>A clean sentence.</p>\n",
    [PAGE]: page,
  };
  for (const name of DOCS) files[`docs/${name}.md`] = "# Doc\n\nA clean sentence.\n";
  return files;
}

const checkCopy = (page: string, extra: Record<string, string> = {}) =>
  runNode(makeTree({ ...copyFiles(page), ...extra }, [COPY]), COPY);

describe("check-copy-rules", () => {
  it("exits 0 on clean copy", () => {
    const { code, out } = checkCopy("A clean sentence.\n");
    expect(out).toContain("check-copy-rules:");
    expect(code).toBe(0);
  });

  const banned = ["robust", "seamless", "comprehensive", "leverage", "delve", "crucial"];
  it.each(banned)("fails on the filler word %s", (word) => {
    const { code, out } = checkCopy(`This is ${word} enough.\n`);
    expect(code).toBe(1);
    expect(out).toContain("banned-word");
    expect(out).toContain(`"${word}"`);
  });

  it.each(["rather than", "not just", "not merely", "isn't about"])(
    "fails on the contrast closer '%s'",
    (phrase) => {
      const { code, out } = checkCopy(`It is fast, ${phrase} slow.\n`);
      expect(code).toBe(1);
      expect(out).toContain("contrast-closer");
    },
  );

  it("fails on a banned word in the README and in a component", () => {
    const readme = checkCopy("Clean.\n", { "README.md": "A seamless install.\n" });
    expect(readme.code).toBe(1);
    expect(readme.out).toContain("README.md:1: banned-word");
    const astro = checkCopy("Clean.\n", { "website/src/components/Hero.astro": "<p>robust</p>\n" });
    expect(astro.code).toBe(1);
    expect(astro.out).toContain("Hero.astro:1: banned-word");
  });

  it("skips fenced blocks and inline code", () => {
    const page = "```\nseamless rather than slow\n```\n\nUse `robust` as a name.\n";
    expect(checkCopy(page).code).toBe(0);
  });
});

describe("check-h1", () => {
  const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
  const run = (pages: Record<string, string>) => {
    const files: Record<string, string> = {};
    for (const [path, body] of Object.entries(pages)) files[`dist/${path}`] = body;
    return runNode(makeTree(files, [H1]), H1, ["dist"]);
  };

  it("exits 0 when every page has exactly one h1", () => {
    const { code, out } = run({
      "index.html": html("<h1>One</h1>"),
      "a/index.html": html("<h1 class='x'>One</h1><h2>Two</h2>"),
    });
    expect(out).toContain("2 pages, one h1 each");
    expect(code).toBe(0);
  });

  it("fails on a page with zero h1", () => {
    const { code, out } = run({
      "index.html": html("<h1>One</h1>"),
      "bad/index.html": html("<h2>Two</h2>"),
    });
    expect(code).toBe(1);
    expect(out).toContain("bad/index.html: 0 h1");
  });

  it("fails on a page with two h1", () => {
    const { code, out } = run({ "index.html": html("<h1>One</h1><h1>Two</h1>") });
    expect(code).toBe(1);
    expect(out).toContain("index.html: 2 h1");
  });

  it("ignores h1 inside comments, scripts and templates", () => {
    const body =
      "<!-- <h1>x</h1> --><script>'<h1>'</script><template><h1>t</h1></template><h1>One</h1>";
    expect(run({ "index.html": html(body) }).code).toBe(0);
  });

  it("skips meta-refresh redirect stubs", () => {
    const stub = '<meta http-equiv="refresh" content="0; url=/">';
    expect(run({ "index.html": html("<h1>One</h1>"), "old/index.html": stub }).code).toBe(0);
  });

  it("fails when the directory has no html pages", () => {
    const { code, out } = run({ "notes.txt": "x" });
    expect(code).toBe(1);
    expect(out).toContain("no html pages");
  });
});

describe("stripCodeSpans", () => {
  const load = async () => {
    const url = pathToFileURL(join(REPO, "website/scripts/lib/strip-code.mjs")).href;
    return (await import(url)) as { stripCodeSpans: (line: string, r?: string) => string };
  };

  it("removes single and double-backtick spans", async () => {
    const { stripCodeSpans } = await load();
    expect(stripCodeSpans("a `b` c")).toBe("a  c");
    expect(stripCodeSpans("a ``b — c`` d")).toBe("a  d");
  });

  it("keeps a single backtick inside a double-backtick span", async () => {
    const { stripCodeSpans } = await load();
    expect(stripCodeSpans("x ``a ` b`` y", "#")).toBe("x # y");
  });

  it("leaves prose outside the spans", async () => {
    const { stripCodeSpans } = await load();
    expect(stripCodeSpans("`a` — `b`", "")).toBe(" — ");
  });
});
