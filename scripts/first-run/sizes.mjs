// Section 3, TOOL LIST SIZES: start the installed server over stdio, send tools/list, and record the tool count and the JSON
// length of the result for BROWX_TOOL_LIST unset (all) and enabled, with the default capabilities and with every documented
// capability. chars = JSON.stringify of the merged `tools/list` result. Tokens are chars / 4 rounded up: an ESTIMATE, not a count.
// tools/list starts no browser. Env: FR_ROOT, FR_WORK, FR_OUT. Exit: 0 table printed, 1 a documented setting does not do what
// the docs say, 2 a tool error (the server does not start).
import "./crash.mjs";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emit, estTokens, layout } from "./block.mjs";
import { startMcp } from "./mcp-client.mjs";
import { cleanEnv } from "./proc.mjs";
import { recorder } from "./recorder.mjs";

const { FR_WORK: WORK, FR_OUT: OUT } = process.env;
if (!WORK || !OUT) {
  console.error("sizes: FR_WORK and FR_OUT must be set (run.sh does that)");
  process.exit(2);
}
const proj = join(WORK, "project");
const rec = recorder(null);
const headers = [
  "section: tool-list-sizes (tools/list over stdio; chars = JSON length of the result; tokens = chars / 4, an ESTIMATE)",
];
const finish = (code, rows = []) => {
  emit("FRSIZES", layout(headers, rows, rec.tail(code), 3400, 0));
  process.exit(code);
};
if (!existsSync(join(proj, "node_modules/.bin/browxai"))) {
  rec.diff("stopped: browxai is not installed");
  finish(2);
}

// Every capability the docs name (AGENTS.md "Capability posture map", docs/threat-model.md). The first four are the defaults.
const DOCUMENTED = [
  "read",
  "navigation",
  "action",
  "human",
  "eval",
  "network-body",
  "byob-attach",
  "clipboard",
  "file-io",
  "secrets",
  "extensions",
  "stealth",
  "credentials",
  "captcha",
  "device-emulation",
  "diagnostics",
  "canvas",
  "replay",
  "native-device",
  "self-approval",
  "human-gate-override",
  "operator-channel",
  "live-view",
];
// These two need a host daemon socket; the server refuses to start with them and no socket.
const NEEDS_DAEMON = ["operator-channel", "live-view"];

const base = cleanEnv(WORK, { BROWX_WORKSPACE: join(WORK, "ws-sizes"), BROWX_HEADLESS: "1" });
mkdirSync(base.BROWX_WORKSPACE, { recursive: true });
const flat = (t, n = 200) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .slice(0, n);
const n = (x) => x.toLocaleString("en-US");

/** Start the server with `extra` env, handshake, page through tools/list. Resolves { ok, initMs, tools, wire } or { ok:false, error }. */
async function list(extra, command = "browxai", args = []) {
  const c = startMcp({ command, args, env: { ...base, ...extra }, cwd: proj });
  try {
    const init = await c.initialize(90_000);
    const tools = [];
    let wire = 0;
    let cursor;
    for (let page = 0; page < 50; page += 1) {
      const r = await c.request("tools/list", cursor ? { cursor } : {}, 60_000);
      if (r.error) throw new Error(`tools/list: ${r.error.message}`);
      tools.push(...(r.result?.tools ?? []));
      wire += r.wireChars;
      cursor = r.result?.nextCursor;
      if (!cursor) break;
    }
    return { ok: true, initMs: init.ms, tools, wire };
  } catch (e) {
    return { ok: false, error: `${flat(e.message, 160)} | stderr: ${flat(c.stderr(), 240)}` };
  } finally {
    await c.close();
  }
}

const stats = (tools) => {
  const sum = (f) =>
    tools.reduce((a, t) => a + (t[f] === undefined ? 0 : JSON.stringify(t[f]).length), 0);
  const chars = JSON.stringify({ tools }).length;
  return {
    count: tools.length,
    chars,
    desc: sum("description"),
    input: sum("inputSchema"),
    output: sum("outputSchema"),
    notes: sum("annotations"),
  };
};
const table = [];
const row = (list_, caps, r) => {
  if (!r.ok) {
    table.push(`${list_} | ${caps} | FAILED: ${flat(r.error, 200)}`);
    return undefined;
  }
  const s = stats(r.tools);
  table.push(
    `${list_} | ${caps} | ${s.count} tools | ${n(s.chars)} chars | ~${n(estTokens(s.chars))} tok (est)`,
  );
  return s;
};

// Startup time to the initialize answer: the bin as a client config names it, and `npx -y browxai` (the installed copy, so no download).
const bin = await list({});
if (!bin.ok) {
  rec.diff(`the server did not start with default settings: ${bin.error}`);
  finish(2);
}
const viaNpx = await list({}, "npx", ["-y", "browxai"]);
headers.push(
  `initialize: browxai ${bin.initMs} ms, npx -y browxai ${viaNpx.ok ? `${viaNpx.initMs} ms` : `FAILED ${flat(viaNpx.error, 120)}`} (installed copy, not a download)`,
);
if (!viaNpx.ok) rec.diff("the page's `npx -y browxai` client command did not start the server");

// Rows 1 and 2: default capabilities.
const allDefault = row("unset (all)", "default 4", bin);
const enabledDefault = row("enabled", "default 4", await list({ BROWX_TOOL_LIST: "enabled" }));
if (!enabledDefault) rec.diff("BROWX_TOOL_LIST=enabled: the server did not start");

// Rows 3 and 4: every documented capability. A server that refuses the full set is retried without the two daemon capabilities.
let wide = DOCUMENTED;
let wideEnv = { BROWX_CAPABILITIES: wide.join(",") };
let probe = await list(wideEnv);
if (!probe.ok) {
  rec.note(
    `all ${wide.length} documented capabilities: the server did not start (${flat(probe.error, 140)}); retried without ${NEEDS_DAEMON.join(", ")}`,
  );
  wide = DOCUMENTED.filter((c) => !NEEDS_DAEMON.includes(c));
  wideEnv = { BROWX_CAPABILITIES: wide.join(",") };
  probe = await list(wideEnv);
}
const wideLabel = `${wide.length} of ${DOCUMENTED.length}`;
const allWide = row("unset (all)", wideLabel, probe);
const enabledWide = row(
  "enabled",
  wideLabel,
  await list({ ...wideEnv, BROWX_TOOL_LIST: "enabled" }),
);
if (!probe.ok) rec.diff("no widened capability set started the server");

// What the docs claim: `enabled` makes the listing smaller; the capability words match the installed package.
if (allDefault && enabledDefault) {
  const dc = allDefault.chars - enabledDefault.chars;
  if (enabledDefault.count >= allDefault.count || dc <= 0) {
    rec.diff(
      `BROWX_TOOL_LIST=enabled is not smaller than all (${enabledDefault.count} vs ${allDefault.count} tools): the docs say it is`,
    );
  } else {
    rec.note(
      `enabled vs all, default capabilities: -${allDefault.count - enabledDefault.count} tools, -${n(dc)} chars (-${Math.round((dc / allDefault.chars) * 100)}%)`,
    );
  }
}
if (allDefault && allWide && allDefault.count !== allWide.count) {
  rec.note(
    `all-mode lists ${allDefault.count} tools by default and ${allWide.count} with widened capabilities`,
  );
}
if (enabledWide && allWide && enabledWide.count > allWide.count)
  rec.diff("enabled lists more tools than all");
try {
  const mod = await import(
    pathToFileURL(join(proj, "node_modules/browxai/dist/util/capabilities.js")).href
  );
  const missing = DOCUMENTED.filter((c) => !mod.ALL_CAPABILITIES.includes(c));
  const extra = mod.ALL_CAPABILITIES.filter((c) => !DOCUMENTED.includes(c));
  if (missing.length || extra.length)
    rec.note(
      `documented list differs from the package: missing from package [${missing}], not in docs list [${extra}]`,
    );
} catch {
  rec.note("could not read the package's capability list to compare");
}

// Where the characters go, and the biggest tools, for the widest listing.
const rows = [
  { head: "LIST | CAPABILITIES | TOOLS | CHARS | TOKENS (chars / 4)" },
  ...table.map((head) => ({ head })),
];
for (const [label, r] of [
  ["default all", bin],
  [`${wideLabel} all`, probe],
]) {
  if (!r.ok) continue;
  const s = stats(r.tools);
  rows.push({
    head: `split (${label}): descriptions ${n(s.desc)}, inputSchema ${n(s.input)}, outputSchema ${n(s.output)}, annotations ${n(s.notes)}, wire ${n(r.wire)}`,
  });
}
if (probe.ok) {
  const top = probe.tools
    .map((t) => [t.name, JSON.stringify(t).length])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  rows.push({
    head: `largest tools (${wideLabel} all): ${top.map(([name, c]) => `${name} ${n(c)}`).join(", ")}`,
  });
}
finish(rec.diffs.length ? 1 : 0, rows);
