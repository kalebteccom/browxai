// Path 3: `browxai plugin` as docs/plugins.md and docs/tool-reference.md show it: help, list, sync on an empty workspace, then
// the registry install of a first-party plugin by name, list, info, upgrade, `doctor`, `plugins_list` over MCP, remove.
// Not exercised, because the published package ships `dist/` only and has no packages/plugins directory: the local-path install
// (`browxai plugin install file:./packages/plugins/...`). Needs the npm registry for the install; no browser starts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { secs } from "./block.mjs";
import { startMcp } from "./mcp-client.mjs";
import { run } from "./proc.mjs";

const first = (t, n = 200) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
const NETWORK = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|network/i;

export async function pluginPart({ rec, env, proj, WORK, facts, toolError }) {
  const ws = join(WORK, "ws-plugin");
  mkdirSync(ws, { recursive: true });
  const penv = { ...env, BROWX_WORKSPACE: ws };
  const sh = { cwd: proj, env: penv, timeoutMs: 300_000 };
  const plugin = (...args) => run("browxai", ["plugin", ...args], sh);
  const { name, showsInstall, showsLocalInstall } = facts.plugin;

  // Help names every subcommand the tool reference lists, and the empty workspace answers list and sync.
  const help = plugin("help");
  const subs = facts.cli.pluginSubs;
  const unlisted = subs.filter((s) => !new RegExp(`^\\s+${s}\\b`, "m").test(help.output));
  const list0 = plugin("list");
  const sync0 = plugin("sync");
  rec.line(
    `[plugin] help ${help.code}, list ${list0.code}, sync ${sync0.code} (empty workspace) | ${subs.length - unlisted.length} of ${subs.length} documented subcommands in help`,
  );
  if (subs.length === 0) rec.diff("no plugin subcommands were read from docs/tool-reference.md");
  if (unlisted.length) rec.diff(`browxai plugin help does not list: ${unlisted.join(", ")}`);
  for (const [label, r] of [
    ["help", help],
    ["list", list0],
    ["sync", sync0],
  ])
    if (r.code !== 0)
      rec.diff(
        `browxai plugin ${label} on an empty workspace exited ${r.code}: ${first(r.output, 120)}`,
      );

  if (!showsInstall) rec.note("docs/plugins.md no longer shows a registry install by package name");
  if (!name) {
    rec.note("docs/plugins.md lists no @browxai/plugin-example, so no first-party install was run");
    return;
  }
  rec.note(
    `not run: ${showsLocalInstall ?? "browxai plugin install file:./..."}, the published package has no packages/plugins directory`,
  );

  // The registry install. A network failure is a tool error, an install that exits non-zero otherwise is a difference.
  const install = plugin("install", name);
  rec.line(
    `[plugin] install ${name} | exit ${install.code} | ${secs(install.ms)} | ${first(install.output.split("\n").filter((l) => /installed /.test(l))[0], 100)}`,
    install.output,
  );
  if (install.code !== 0) {
    if (NETWORK.test(install.output))
      toolError(
        `plugin install ${name}: the npm registry is not reachable: ${first(install.output, 160)}`,
      );
    else
      rec.diff(
        `browxai plugin install ${name} exited ${install.code}: ${first(install.output, 200)}`,
      );
    return;
  }
  if (!/\(trust=kalebtec\)/.test(install.output))
    rec.diff(
      `install ${name} did not report trust=kalebtec, docs/plugins.md lists it as kalebtec: ${first(install.output.split("\n").filter((l) => /installed /.test(l))[0], 120)}`,
    );

  const list1 = plugin("list");
  const info = plugin("info", name);
  const upgrade = plugin("upgrade", name);
  let parsed;
  try {
    parsed = JSON.parse(info.output);
  } catch {
    /* reported below */
  }
  rec.line(
    `[plugin] list ${list1.code}, info ${info.code}, upgrade ${upgrade.code} | list shows ${name}: ${list1.output.includes(name) ? "yes" : "NO"}, info manifest ${parsed?.manifest?.name ?? "NONE"}@${parsed?.manifest?.version ?? "?"}, lock pin ${parsed?.lock?.contentSha256 ? "yes" : "NO"}`,
  );
  if (!list1.output.includes(name))
    rec.diff(`browxai plugin list does not show ${name} after the install`);
  if (info.code !== 0 || !parsed)
    rec.diff(
      `browxai plugin info ${name} exited ${info.code} and printed no JSON: ${first(info.output, 120)}`,
    );
  else if (
    parsed.manifest?.name !== name ||
    !parsed.lock?.contentSha256 ||
    parsed.declared?.enabled !== true
  )
    rec.diff(
      `browxai plugin info ${name}: the docs say it prints the full manifest and lock entry, it printed manifest ${parsed.manifest?.name}, lock pin ${Boolean(parsed.lock?.contentSha256)}, enabled ${parsed.declared?.enabled}`,
    );
  if (upgrade.code !== 0)
    rec.diff(
      `browxai plugin upgrade ${name} exited ${upgrade.code}: ${first(upgrade.output, 160)}`,
    );

  // doctor reads the plugin surface without running plugin code; plugins_list reports the live load after a fresh start.
  const doctor = run("browxai", ["doctor"], sh);
  const area = doctor.output.split("\n").find((l) => /^\s+[✓✗⚠] plugins\b/.test(l)) ?? "";
  let status = "n/a";
  let trust = "n/a";
  const client = startMcp({ command: "browxai", env: { ...penv, BROWX_HEADLESS: "1" }, cwd: proj });
  try {
    await client.initialize(90_000);
    const r = await client.callTool("plugins_list", {});
    const row = r.data?.plugins?.find((p) => p.name === name);
    status = row?.status ?? "missing";
    trust = row?.trust ?? "n/a";
    if (status !== "loaded")
      rec.diff(
        `plugins_list shows ${name} as "${status}" after a fresh start, the docs say to look for "loaded"${row?.statusReason ? ` (${first(row.statusReason, 100)})` : ""}`,
      );
  } finally {
    await client.close();
  }
  rec.line(
    `[plugin] doctor plugins area: ${first(area, 60) || "none"} | plugins_list ${name}: ${status}, trust ${trust}`,
  );
  if (!area.includes("✓"))
    rec.diff(
      `browxai doctor does not tick the plugins area with ${name} installed: ${first(area || doctor.output, 160)}`,
    );

  const remove = plugin("remove", name);
  const list2 = plugin("list");
  rec.line(
    `[plugin] remove ${remove.code}, list after ${list2.code} | ${/no plugins declared/.test(list2.output) ? "empty again" : "STILL LISTED"}`,
  );
  if (remove.code !== 0)
    rec.diff(`browxai plugin remove ${name} exited ${remove.code}: ${first(remove.output, 160)}`);
  else if (list2.output.includes(name))
    rec.diff(`browxai plugin list still shows ${name} after remove`);
}
