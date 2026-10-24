#!/usr/bin/env node
// scripts/check-examples.mjs
//
// Checks the runnable examples in the README, the docs and the harness setup
// against the source tree. Plain Node, no dependencies, under 10 seconds.
//
//   - Fenced bash/sh blocks: every `browxai <subcommand> ...` line names a
//     subcommand and flags that src/cli.ts and src/cli/*.ts define (the registry
//     text is parsed, nothing is imported).
//   - Fenced JSON blocks that hold an MCP config parse (`json` strictly, `jsonc`
//     with comments and trailing commas), and their entries have a command, string
//     args and a string env.
//   - Every BROWX_* name in an example file exists in a non-test file under src/.
//   - Every BROWX_CAPABILITIES list in a fenced block names real capabilities and
//     keeps the four defaults, since the variable replaces the default set.
//   - With dist/cli.js built, a few safe CLI probes run: --version, --help and one
//     offline probe per subcommand the examples use (doctor, and the usage text of
//     chrome, init, serve and plugin). Nothing here starts a server, launches a
//     browser or opens a network connection. Without dist/cli.js those probes are
//     skipped and only the static checks run.
//
// Exits 0 on pass, 1 on fail with a list of file:line problems.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_CLI = join(ROOT, "dist", "cli.js");
const PROBE_TIMEOUT_MS = 8000;

// The files checked first. The first two must each hold an MCP config block.
const SPEC_FILES = [
  { path: "README.md", needsMcp: true },
  { path: "website/src/content/docs/getting-started.md", needsMcp: true },
  { path: "website/src/content/docs/guides/configuration.md", needsMcp: false },
];

// Directories whose Markdown also carries examples, and JSON files that are configs.
const EXTRA_DIRS = ["docs", "website/src/content/docs", "harness", "packages/plugins"];
const SKIP_DIRS = new Set(["node_modules", "rfcs", "ai-context", "dist"]);
const JSON_CONFIGS = ["harness/adapters/claude-code/mcp.json", "harness/adapters/pi/mcp.json"];

// Flags that src/cli.ts handles inline, outside the subcommand registry.
const GLOBAL_FLAGS = ["--version", "-v", "--help", "-h", "--engine"];

// One offline probe per registered subcommand. `exit` lists the accepted exit codes.
const PROBES = {
  doctor: {
    args: ["doctor"],
    exit: [0, 1],
    stream: "stdout",
    match: /browxai doctor \(v/,
  },
  chrome: {
    args: ["chrome"],
    exit: [2],
    stream: "stderr",
    match: /usage: browxai chrome/,
  },
  init: {
    args: ["init"],
    exit: [2],
    stream: "stderr",
    match: /usage: browxai init/,
  },
  serve: {
    args: ["serve"],
    exit: [2],
    stream: "stderr",
    match: /usage: browxai serve/,
  },
  plugin: {
    args: ["plugin", "--help"],
    exit: [0],
    stream: "stdout",
    match: /Usage: browxai plugin/,
  },
};

const CAPS_RE = /BROWX_CAPABILITIES["']?\s*[=:]\s*["']?([a-z][a-z,-]*)/g;

const errors = [];
const notes = [];

function fail(file, line, message) {
  errors.push(`${file}:${line}: ${message}`);
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

function listFiles(rel, accept) {
  const out = [];
  const dir = join(ROOT, rel);
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listFiles(child, accept));
    } else if (accept(entry.name)) {
      out.push(child);
    }
  }
  return out;
}

// --- Source facts -----------------------------------------------------------

function quotedList(source, name) {
  const block = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
  return [...(block?.[1] ?? "").matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
}

function names(text, re) {
  return new Set([...text.matchAll(re)].map((m) => m[1]));
}

// Registration names are read from code, not from the comments that describe the pattern.
const noComments = (text) => text.replace(/^[ \t]*\/\/.*$/gm, "");

function sourceFacts() {
  const isSource = (n) => n.endsWith(".ts") && !n.endsWith(".test.ts");
  const srcText = listFiles("src", isSource).map(read).join("\n");
  const cliFiles = [...listFiles("src/cli", isSource), "src/cli.ts", "src/plugin/cli.ts"];
  const caps = read("src/util/capabilities.ts");
  const facts = {
    srcText,
    cliText: cliFiles.map(read).join("\n"),
    commands: names(
      noComments(read("src/cli/register-commands.ts")),
      /registerCommand\("([\w-]+)"/g,
    ),
    pluginVerbs: names(noComments(read("src/plugin/cli.ts")), /registerPluginCommand\("([\w-]+)"/g),
    chromeSubs: names(noComments(read("src/cli/chrome.ts")), /sub === "([\w-]+)"/g),
    capabilities: new Set(quotedList(caps, "ALL_CAPABILITIES")),
    defaults: quotedList(caps, "DEFAULT_CAPABILITIES"),
  };
  if (facts.commands.size === 0) fail("src/cli/register-commands.ts", 1, "no subcommands found");
  if (facts.capabilities.size === 0) fail("src/util/capabilities.ts", 1, "no capabilities found");
  if (facts.defaults.length === 0) fail("src/util/capabilities.ts", 1, "no default capabilities");
  return facts;
}

// --- Markdown extraction ----------------------------------------------------

// Fenced blocks as { lang, body, line }, where `line` is the first body line.
function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  text.split("\n").forEach((raw, i) => {
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(raw);
    if (open === null) {
      if (fence) open = { marker: fence[1], lang: fence[2], line: i + 2, body: [] };
      return;
    }
    const closing = raw.trim();
    const isClose = /^(`{3,}|~{3,})$/.test(closing) && closing[0] === open.marker[0];
    if (isClose) {
      blocks.push({ lang: open.lang, body: open.body.join("\n"), line: open.line });
      open = null;
    } else {
      open.body.push(raw);
    }
  });
  return blocks;
}

// Commands in a shell block: joins `\` continuations, drops comments, and keeps
// only `$ ` lines when the block uses a prompt (the other lines are output).
function shellCommands(block) {
  const joined = [];
  let text = "";
  let line = block.line;
  block.body.split("\n").forEach((row, i) => {
    if (text === "") line = block.line + i;
    const trimmed = row.trimEnd();
    if (trimmed.endsWith("\\")) {
      text += `${trimmed.slice(0, -1)} `;
      return;
    }
    joined.push({ text: text + trimmed, line });
    text = "";
  });
  const prompted = joined.some((j) => j.text.startsWith("$ "));
  const commands = [];
  for (const j of joined) {
    if (prompted && !j.text.startsWith("$ ")) continue;
    const clean = j.text
      .replace(/^\$ /, "")
      .replace(/\s+#.*$/, "")
      .trim();
    if (clean !== "" && !clean.startsWith("#")) commands.push({ text: clean, line: j.line });
  }
  return commands;
}

// --- Checks -----------------------------------------------------------------

function checkCliCommand(file, cmd, facts, used) {
  const words = cmd.text.split(/\s+/);
  while (words.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words.shift();
  if (words[0] !== "browxai" || words.length === 1) return;
  const problem = (message) => fail(file, cmd.line, `${message} in: ${cmd.text}`);
  const [, first, second] = words;
  if (first.endsWith(":") || /^[<[]/.test(first)) return;
  if (first.startsWith("-")) {
    if (!GLOBAL_FLAGS.includes(first.split("=")[0])) problem(`unknown flag "${first}"`);
    return;
  }
  if (!facts.commands.has(first)) {
    problem(`"browxai ${first}" is not a subcommand`);
    return;
  }
  used.add(first);
  const concrete = second !== undefined && !/^[<[-]/.test(second);
  if (first === "chrome" && concrete && !facts.chromeSubs.has(second)) {
    problem(`"browxai chrome ${second}" is not a chrome subcommand`);
  }
  const verbOk = facts.pluginVerbs.has(second) || ["help", "--help", "-h"].includes(second);
  if (first === "plugin" && concrete && !verbOk) {
    problem(`"browxai plugin ${second}" is not a plugin verb`);
  }
  for (const word of words.slice(2)) {
    const flag = word.split("=")[0];
    if (/^--[a-z][a-z-]*$/.test(flag) && !facts.cliText.includes(flag)) {
      problem(`flag "${flag}" is not defined by the CLI sources`);
    }
  }
}

function stripJsonc(src) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      i += 1;
    } else if (c === '"') {
      inString = true;
      out += c;
      i += 1;
    } else if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function checkCapabilityList(bad, value, facts) {
  const list = value.split(",").filter((c) => c !== "");
  for (const cap of list) {
    if (!facts.capabilities.has(cap)) bad(`BROWX_CAPABILITIES names unknown "${cap}"`);
  }
  const missing = facts.defaults.filter((d) => !list.includes(d));
  if (missing.length > 0) {
    bad(`BROWX_CAPABILITIES "${value}" drops the defaults: ${missing.join(", ")}`);
  }
}

function checkMcpEntry(bad, name, entry, facts) {
  if (typeof entry?.command !== "string") bad(`mcpServers.${name} has no command`);
  const args = entry?.args;
  const stringArray = Array.isArray(args) && args.every((a) => typeof a === "string");
  if (args !== undefined && !stringArray) bad(`mcpServers.${name}.args is not a string array`);
  const env = entry?.env;
  if (env === undefined) return;
  if (env === null || typeof env !== "object") {
    bad(`mcpServers.${name}.env is not an object`);
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      bad(`mcpServers.${name}.env.${key} is not a string`);
    } else if (key === "BROWX_CAPABILITIES") {
      checkCapabilityList(bad, value, facts);
    }
  }
}

function checkMcpConfig(file, line, source, facts) {
  const bad = (message) => fail(file, line, message);
  let config;
  try {
    config = JSON.parse(source);
  } catch (err) {
    bad(`MCP config does not parse: ${err.message}`);
    return;
  }
  const servers = config?.mcpServers;
  if (servers === null || typeof servers !== "object") {
    bad("MCP config has no mcpServers object");
    return;
  }
  for (const [name, entry] of Object.entries(servers)) checkMcpEntry(bad, name, entry, facts);
}

function checkFile(rel, facts, needsMcp, used) {
  const text = read(rel);
  let mcpBlocks = 0;
  for (const name of new Set(text.match(/BROWX_[A-Z][A-Z0-9_]*/g) ?? [])) {
    const token = name.replace(/_+$/, "");
    if (token.length > "BROWX_".length && !facts.srcText.includes(token)) {
      fail(rel, text.slice(0, text.indexOf(name)).split("\n").length, `${token} is not in src/`);
    }
  }
  for (const block of fencedBlocks(text)) {
    if (/^(sh|bash|shell|zsh|console)$/.test(block.lang)) {
      for (const cmd of shellCommands(block)) checkCliCommand(rel, cmd, facts, used);
    }
    for (const m of block.body.matchAll(CAPS_RE)) {
      const line = block.line + block.body.slice(0, m.index).split("\n").length - 1;
      checkCapabilityList((message) => fail(rel, line, message), m[1], facts);
    }
    if (/^jsonc?$/.test(block.lang) && block.body.includes('"mcpServers"')) {
      mcpBlocks += 1;
      const source = block.lang === "jsonc" ? stripJsonc(block.body) : block.body;
      checkMcpConfig(rel, block.line, source, facts);
    }
  }
  if (needsMcp && mcpBlocks === 0) fail(rel, 1, "no MCP config block found");
}

// --- CLI probes -------------------------------------------------------------

function probe(args, env) {
  return new Promise((done) => {
    const options = { cwd: ROOT, env, timeout: PROBE_TIMEOUT_MS, encoding: "utf8" };
    execFile(process.execPath, [DIST_CLI, ...args], options, (err, stdout, stderr) => {
      let code = 0;
      if (err !== null) code = err.killed ? "timeout" : err.code;
      done({ code, stdout, stderr });
    });
  });
}

function checkVersion(r, version) {
  if (r.code !== 0) return `exit ${r.code}`;
  const out = r.stdout.trim();
  return out === version ? null : `printed "${out}", package.json says ${version}`;
}

function checkHelp(r, facts) {
  if (r.code !== 0) return `exit ${r.code}`;
  const absent = [...facts.commands].filter((c) => !r.stdout.includes(`browxai ${c}`));
  return absent.length === 0 ? null : `usage text does not mention: ${absent.join(", ")}`;
}

function checkProbe(r, spec) {
  if (!spec.exit.includes(r.code)) return `exit ${r.code}, want ${spec.exit.join(" or ")}`;
  return spec.match.test(r[spec.stream]) ? null : `${spec.stream} does not match ${spec.match}`;
}

async function runProbes(facts, used) {
  const workspace = mkdtempSync(join(tmpdir(), "browxai-examples-"));
  // A clean environment: no BROWX_* from the caller, an empty workspace and home.
  const env = { PATH: process.env.PATH ?? "", HOME: workspace, BROWX_WORKSPACE: workspace };
  const version = JSON.parse(read("package.json")).version;
  const jobs = [];
  const add = (label, args, judge) => jobs.push({ label, run: probe(args, env), judge });
  add("--version", ["--version"], (r) => checkVersion(r, version));
  add("--help", ["--help"], (r) => checkHelp(r, facts));
  for (const name of [...used].sort()) {
    const spec = PROBES[name];
    if (spec === undefined) {
      notes.push(`no offline probe for "browxai ${name}", add one to PROBES`);
    } else {
      add(`browxai ${name}`, spec.args, (r) => checkProbe(r, spec));
    }
  }
  try {
    for (const job of jobs) {
      const problem = job.judge(await job.run);
      if (problem !== null) fail("dist/cli.js", 1, `${job.label}: ${problem}`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  return jobs.length;
}

// --- Main -------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const facts = sourceFacts();
  const used = new Set();
  const files = new Map(SPEC_FILES.map((f) => [f.path, f.needsMcp]));
  for (const dir of EXTRA_DIRS) {
    for (const file of listFiles(dir, (n) => /\.mdx?$/.test(n))) {
      if (!files.has(file)) files.set(file, false);
    }
  }
  for (const [file, needsMcp] of files) checkFile(file, facts, needsMcp, used);
  for (const file of JSON_CONFIGS) checkMcpConfig(file, 1, read(file), facts);
  let probes = 0;
  if (existsSync(DIST_CLI)) {
    probes = await runProbes(facts, used);
  } else {
    notes.push("dist/cli.js not found: CLI probes skipped, static checks only (run pnpm build)");
  }
  for (const note of notes) console.log(`check-examples: note: ${note}`);
  if (errors.length > 0) {
    console.error(`check-examples: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  ${e}`);
    process.exitCode = 1;
    return;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ran = probes > 0 ? `${probes} CLI probes ran` : "CLI probes skipped";
  console.log(`check-examples: ok, ${files.size} files, ${used.size} commands, ${ran}, ${secs}s`);
}

main().catch((err) => {
  console.error(`check-examples: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
