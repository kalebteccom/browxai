// Serve the built docs site on 127.0.0.1 the way Netlify serves it, for the Lighthouse run only.
// Usage: node serve.mjs <dir> <port> <headers-file>
// Two things the bare design-audit server does not do, and Lighthouse flags (cache-insight, document-latency-insight) when they are missing:
//   1. Compression: text responses go out brotli or gzip, as the client's Accept-Encoding allows. Each file is compressed once and kept, so the run never spends CPU on it.
//   2. Headers: every rule of the Netlify `_headers` file (website/public/_headers, copied into the dist root by the build) whose path pattern matches is applied. The file is parsed here, no value is copied, so a change there reaches the run on its own.
// Loopback only, like scripts/design-audit/serve.mjs; the Chrome fence is unchanged.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const [dir, port, headersFile] = process.argv.slice(2);
if (!dir || !port || !headersFile) {
  console.error("usage: serve.mjs <dir> <port> <headers-file>");
  process.exit(2);
}
const root = resolve(dir);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};
// Formats that are not already compressed. Images and fonts (woff, woff2) go out as they are.
const COMPRESSIBLE = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
  ".ico",
  ".txt",
  ".xml",
]);
const MIN_COMPRESS_BYTES = 1024;

/** Netlify `_headers`: a path pattern line, then indented `Key: value` lines. Same reading as test/scripts/netlify-headers.test.ts. */
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z-]*):\s*(.+)$/.exec(raw.trim());
    if (kv && current) current.headers[kv[1]] = kv[2].trim();
  }
  return rules.map(({ pattern, headers }) => ({
    regex: new RegExp(
      "^" +
        pattern
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    ),
    headers,
  }));
}

let rules;
try {
  rules = parseHeaders(readFileSync(resolve(headersFile), "utf8"));
} catch (err) {
  console.error(`serve.mjs: cannot read ${headersFile}: ${err.message}`);
  process.exit(2);
}
if (!rules.length) {
  console.error(`serve.mjs: ${headersFile} holds no rules`);
  process.exit(2);
}

/** Every matching rule applies; a later rule wins on the same header name. */
function headersFor(pathname) {
  const out = {};
  for (const rule of rules) if (rule.regex.test(pathname)) Object.assign(out, rule.headers);
  return out;
}

const cache = new Map();
/** The body in the best encoding the client accepts, compressed once per file and encoding. */
async function encode(file, body, accept) {
  if (!COMPRESSIBLE.has(extname(file)) || body.length < MIN_COMPRESS_BYTES) return { body };
  const encoding = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
  if (!encoding) return { body };
  const key = `${encoding}:${file}`;
  if (!cache.has(key)) {
    const packed =
      encoding === "br"
        ? await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
        : await gz(body, { level: 9 });
    cache.set(key, packed);
  }
  return { body: cache.get(key), encoding };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    let file = join(root, normalize(pathname));
    if (file !== root && !file.startsWith(root + sep)) throw new Error("outside root");
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const raw = await readFile(file);
    const { body, encoding } = await encode(
      file,
      raw,
      String(req.headers["accept-encoding"] ?? ""),
    );
    const head = {
      ...headersFor(pathname),
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
    };
    if (COMPRESSIBLE.has(extname(file))) head.vary = "Accept-Encoding";
    if (encoding) head["content-encoding"] = encoding;
    res.writeHead(200, head);
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});
server.listen(Number(port), "127.0.0.1");
