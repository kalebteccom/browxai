// Print the pages of the built docs site, one URL path per line (for example /guides/configuration/ and /404.html).
// Usage: node list-pages.mjs <dist-dir>
// The list comes from dist/sitemap-<n>.xml. When dist has no sitemap it falls back to every index.html under dist.
// /404.html is always added (the sitemap never lists it). A listed page with no file in dist is an error (exit 2).
// Pages that are in dist but not in the sitemap go to stderr, so a page the sitemap leaves out is visible in the log.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: list-pages.mjs <dist-dir>");
  process.exit(2);
}
const dist = resolve(dir);

const walk = (d, out) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== "pagefind" && e.name !== "_astro") walk(join(d, e.name), out);
    } else if (e.name === "index.html") {
      const rel = relative(dist, d).split(sep).join("/");
      out.add(rel ? `/${rel}/` : "/");
    }
  }
  return out;
};

const fromSitemap = new Set();
for (const f of readdirSync(dist).filter((n) => /^sitemap-\d+\.xml$/.test(n))) {
  const xml = readFileSync(join(dist, f), "utf8");
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const path = decodeURIComponent(new URL(m[1]).pathname);
    fromSitemap.add(path);
  }
}
const found = walk(dist, new Set());
const pages = fromSitemap.size > 0 ? fromSitemap : found;
if (fromSitemap.size > 0) {
  const extra = [...found].filter((p) => !fromSitemap.has(p));
  if (extra.length) console.error(`list-pages: in dist but not in the sitemap: ${extra.join(" ")}`);
}
if (existsSync(join(dist, "404.html"))) pages.add("/404.html");

const missing = [];
for (const p of pages) {
  const file = join(dist, p.endsWith("/") ? `${p}index.html` : p);
  if (!file.startsWith(dist + sep) || !existsSync(file)) missing.push(p);
}
if (missing.length) {
  console.error(`list-pages: no file in dist for: ${missing.join(" ")}`);
  process.exit(2);
}
if (pages.size === 0) {
  console.error("list-pages: no pages found");
  process.exit(2);
}
console.log([...pages].sort().join("\n"));
