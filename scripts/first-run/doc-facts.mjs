// What the getting-started page and the README quote, read from the checkout at run time, so the comparison follows the docs
// when they change. Nothing here is hard-coded except the patterns that find the quoted strings.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PIN = /npx playwright-core@(\d+\.\d+\.\d+)\s+install chromium/;

/** docFacts(repoRoot) -> what the page quotes (undefined where it quotes nothing). */
export function docFacts(root) {
  const page = readFileSync(join(root, "website/src/content/docs/getting-started.md"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const pin = PIN.exec(page)?.[1];
  // The smoke line the page quotes: `✓ first snapshot in N ms`.
  const smoke = /`(✓ first snapshot in N ms)`/.exec(page)?.[1];
  return {
    pin,
    readmePin: PIN.exec(readme)?.[1],
    installCmd: pin ? `npx playwright-core@${pin} install chromium` : undefined,
    depsCmd:
      pin && /--with-deps/.test(page)
        ? `npx playwright-core@${pin} install --with-deps chromium`
        : undefined,
    sizeMb: Number(/about (\d+) MB/.exec(page)?.[1]) || undefined,
    nodeMin: Number(/Node (\d+) or newer/.exec(page)?.[1]) || undefined,
    smokeRe: smoke ? /^\s*✓ first snapshot in \d+ ms\s*$/m : undefined,
    quotedSmoke: smoke,
    // The page names a browser command for a newcomer without Chrome.
    tellsBrowser: /install chromium/.test(page),
    cursorSnippetCommand: /"command": "browxai"/.test(page) ? "browxai" : undefined,
    bakSuffix: /\.browxai-bak/.test(page) ? ".browxai-bak" : undefined,
  };
}

/** Sum the "of 160.4 MiB" sizes Playwright prints while it downloads; undefined when it printed none. */
export function downloadedBytes(output) {
  const units = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  // Playwright prints progress lines for one archive several times; keep the largest size per archive.
  let total = 0;
  let seen = false;
  let current = 0;
  for (const line of String(output).split("\n")) {
    if (/^Downloading |downloaded to /.test(line) && current) {
      total += current;
      current = 0;
    }
    const m = /of ([\d.]+) (KiB|MiB|GiB)/.exec(line);
    if (m) {
      seen = true;
      current = Math.max(current, Number(m[1]) * units[m[2]]);
    }
  }
  total += current;
  return seen ? total : undefined;
}
