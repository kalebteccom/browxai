// Path 4: a capability refusal as the troubleshooting page describes it. Call a gated tool (eval_js) with the default
// capabilities and compare the refusal text and its hint with what "A tool is disabled" quotes and says to do. Then follow
// the page's fix: restart with BROWX_CAPABILITIES widened and confirm the tool runs. Also the page's other claims about the
// same refusal: `set_config` cannot turn the capability on, the default tool list leaves the tool out, and with
// BROWX_TOOL_LIST=all the tool is listed and a call by name returns the same refusal. Only the last step starts a browser.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { secs } from "./block.mjs";
import { PAGE_TITLE } from "./fixture.mjs";
import { startMcp } from "./mcp-client.mjs";

const first = (t, n = 200) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .slice(0, n);
const DEFAULTS = ["read", "navigation", "action", "human"];

async function toolNames(client) {
  const names = [];
  let cursor;
  for (let page = 0; page < 50; page += 1) {
    const r = await client.request("tools/list", cursor ? { cursor } : {}, 60_000);
    if (r.error) throw new Error(`tools/list: ${r.error.message}`);
    names.push(...(r.result?.tools ?? []).map((t) => t.name));
    cursor = r.result?.nextCursor;
    if (!cursor) break;
  }
  return names;
}

/** Start the server with `extra` env, run `fn(client)`, always close it. */
async function withServer({ env, proj }, extra, fn) {
  const client = startMcp({ command: "browxai", env: { ...env, ...extra }, cwd: proj });
  try {
    await client.initialize(90_000);
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function refusalPart({ rec, env, proj, WORK, fixture, facts, browsersOk, toolError }) {
  const f = facts.refusal;
  if (!f.quote || !f.tool || !f.list) {
    rec.diff(
      "the troubleshooting page no longer quotes a disabled-tool refusal with a BROWX_CAPABILITIES line, so there is nothing to compare",
    );
    return;
  }
  const ws = join(WORK, "ws-refusal");
  mkdirSync(ws, { recursive: true });
  const base = { ...env, BROWX_WORKSPACE: ws, BROWX_HEADLESS: "1" };
  const ctx = { env: base, proj };
  const argsFor = { expr: "1 + 1" };

  // (a) Default capabilities: the refusal, then set_config, then the list.
  let refusal;
  let setConfigWorked = false;
  const t0 = Date.now();
  await withServer(ctx, {}, async (c) => {
    const names = await toolNames(c);
    if (names.includes(f.tool))
      rec.diff(
        `with the default tool list ${f.tool} is listed, the configuration page says the default list shows only the tools the server can run`,
      );
    const r = await c.callTool(f.tool, argsFor);
    refusal = r.data;
    const d = r.data ?? {};
    if (!r.isError || d.ok !== false) {
      rec.diff(`${f.tool} with the default capabilities was not refused: ${first(r.text, 160)}`);
      return;
    }
    if (d.error !== f.quote)
      rec.diff(
        `the refusal prints "${first(d.error, 120)}", the troubleshooting page quotes "${f.quote}"`,
      );
    if (d.requiredCapability !== f.capability)
      rec.diff(
        `the refusal names capability "${d.requiredCapability}", the page names "${f.capability}"`,
      );
    const hint = String(d.hint ?? "");
    if (!hint) rec.diff("the refusal has no hint");
    const lacks = [
      ...(hint.includes("BROWX_CAPABILITIES") ? [] : ["BROWX_CAPABILITIES"]),
      ...(hint.includes(f.list) ? [] : [`the page's list ${f.list}`]),
      ...f.mentions.filter((w) => !hint.toLowerCase().includes(w)),
      ...(f.link && !hint.includes(f.link) ? [f.link] : []),
    ];
    if (hint && lacks.length)
      rec.diff(`the refusal hint does not mention what the page says it does: ${lacks.join(", ")}`);
    // The page: "set_config cannot turn one on."
    await c.callTool("set_config", {
      scope: "user",
      patch: { capabilities: [...DEFAULTS, f.capability] },
    });
    const again = await c.callTool(f.tool, argsFor);
    setConfigWorked = !again.isError && again.data?.ok !== false;
    if (setConfigWorked)
      rec.diff(
        `set_config turned capability "${f.capability}" on, the page says it cannot: ${first(again.text, 120)}`,
      );
  });
  rec.line(
    `[refusal] ${f.tool}, default capabilities | ${refusal?.ok === false ? "refused" : "NOT refused"} | requiredCapability ${refusal?.requiredCapability}, hint ${String(refusal?.hint ?? "").length} chars, set_config enables it: ${setConfigWorked ? "YES" : "no"} | ${secs(Date.now() - t0)}`,
  );

  // (b) BROWX_TOOL_LIST=all: listed, and the same refusal by name.
  await withServer(ctx, { BROWX_TOOL_LIST: "all" }, async (c) => {
    const listed = (await toolNames(c)).includes(f.tool);
    const r = await c.callTool(f.tool, argsFor);
    const same = refusal && r.data?.error === refusal.error && r.data?.hint === refusal.hint;
    rec.line(
      `[refusal] BROWX_TOOL_LIST=all | ${f.tool} listed: ${listed ? "yes" : "NO"}, refused by name with the same text and hint: ${same ? "yes" : "NO"}`,
    );
    if (!listed)
      rec.diff(
        `BROWX_TOOL_LIST=all does not list ${f.tool}, the page says toolList all lists every tool`,
      );
    if (!same)
      rec.diff(
        `BROWX_TOOL_LIST=all: a call to ${f.tool} by name did not return the same refusal and hint`,
      );
  });

  // (c) The page's fix: BROWX_CAPABILITIES as written, restart, and the tool runs. This one starts a browser.
  if (!browsersOk) {
    toolError(
      "the widened-capability run was skipped: the fence check did not pass, so no browser may start",
    );
    return;
  }
  const t1 = Date.now();
  await withServer(ctx, { BROWX_CAPABILITIES: f.list }, async (c) => {
    const S = "fr-cap";
    const open = await c.callTool("open_session", { session: S, mode: "incognito" }, 90_000);
    const nav = open.isError
      ? open
      : await c.callTool("navigate", { session: S, url: fixture.url }, 90_000);
    const r = nav.isError
      ? nav
      : await c.callTool(f.tool, { session: S, expr: "document.title" }, 30_000);
    const ok = !r.isError && r.data?.value === PAGE_TITLE;
    rec.line(
      `[refusal] BROWX_CAPABILITIES=${f.list} | ${f.tool} ${ok ? "ran" : "FAILED"}, value ${JSON.stringify(r.data?.value)} | ${secs(Date.now() - t1)}`,
      ok ? "" : r.text,
    );
    if (!ok)
      rec.diff(
        `after restarting with BROWX_CAPABILITIES=${f.list}, ${f.tool} did not return "${PAGE_TITLE}": ${first(r.text, 200)}`,
      );
    await c.callTool("close_session", { session: S });
  });
}
