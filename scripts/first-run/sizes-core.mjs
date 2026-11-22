// Section 3, TOOL LIST SIZES, core profile rows: tools/list with BROWX_TOOL_PROFILE=core (config key `toolProfile`, added in 0.18.0)
// with the default capabilities, once with BROWX_TOOL_LIST unset (enabled) and once with all, the ratio against the default
// listing and against all, the split into the core tools, plugin tools and `tool_catalog`, and the size of one `tool_catalog` reply.
// The pure helpers (atLeast, pct, splitCore) are covered by test/scripts/first-run-block.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { estTokens } from "./block.mjs";
import { startMcp } from "./mcp-client.mjs";

export const PROFILE_SINCE = "0.18.0";
export const CATALOG = "tool_catalog";
/** The core listing has to stay under this share of the default (enabled) listing. */
export const CORE_SHARE_LIMIT = 0.4;
/** RFC 0010's estimate of the core listing, in characters, and of one full `tool_catalog` reply. */
export const RFC_CORE_CHARS = 45_000;
export const RFC_CATALOG_REPLY_CHARS = 24_000;
export const CORE_TOOL_COUNT = 24;

/** True when `version` (x.y.z, a prerelease suffix is ignored) is at least `min`. An unreadable version is false. */
export function atLeast(version, min) {
  const parse = (v) =>
    /^(\d+)\.(\d+)\.(\d+)/
      .exec(String(v ?? "").trim())
      ?.slice(1)
      .map(Number);
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** `part` as a percentage of `whole`, one decimal ("19.6"). */
export const pct = (part, whole) => (Math.round((part / whole) * 1000) / 10).toFixed(1);

/**
 * Split a tools/list result into the core tools, plugin tools and the discovery tool. Sizes are the JSON length of each tool.
 * -> { core: { count, chars }, plugin: [{ name, chars }], catalog: chars | undefined }
 * Under the core profile every listed tool that is neither core nor `tool_catalog` is a plugin tool.
 */
export function splitCore(tools, coreNames) {
  const core = new Set(coreNames);
  const out = { core: { count: 0, chars: 0 }, plugin: [], catalog: undefined };
  for (const t of tools) {
    const chars = JSON.stringify(t).length;
    if (core.has(t.name)) {
      out.core.count += 1;
      out.core.chars += chars;
    } else if (t.name === CATALOG) out.catalog = chars;
    else out.plugin.push({ name: t.name, chars });
  }
  return out;
}

const installedVersion = (proj) => {
  try {
    return JSON.parse(readFileSync(join(proj, "node_modules/browxai/package.json"), "utf8"))
      .version;
  } catch {
    return undefined;
  }
};

/** The 24 names the installed package freezes as its core set, or undefined when its module cannot be read. */
async function installedCoreNames(proj) {
  try {
    const mod = await import(
      pathToFileURL(join(proj, "node_modules/browxai/dist/util/tool-profile.js")).href
    );
    return Array.isArray(mod.CORE_TOOLS) ? [...mod.CORE_TOOLS] : undefined;
  } catch {
    return undefined;
  }
}

/** Start the core profile server, call `tool_catalog` once. Resolves { ok, chars, wire, omitted } or { ok:false, error }. */
async function catalogReply(env, cwd, flat) {
  const c = startMcp({ command: "browxai", args: [], env, cwd });
  try {
    await c.initialize(90_000);
    const r = await c.callTool(CATALOG, {}, 60_000);
    if (r.isError) return { ok: false, error: flat(r.text, 160) };
    return { ok: true, chars: r.textChars, wire: r.wireChars, omitted: r.data?.omitted };
  } catch (e) {
    return { ok: false, error: `${flat(e.message, 120)} | stderr: ${flat(c.stderr(), 160)}` };
  } finally {
    await c.close();
  }
}

/**
 * Add the core profile rows to the table (through `row`), record DIFF and NOTE lines on `rec`, and return the extra lines for the block.
 * ctx: { proj, base, list, row, rec, n, flat, fullRun, enabledDefault, allDefault }
 *   list(extraEnv) -> { ok, tools, ... } (sizes.mjs), row(label, caps, run) -> { count, chars, ... } | undefined,
 *   fullRun: the default (full profile) run, enabledDefault / allDefault: stats of the default and `all` rows.
 */
export async function measureCore(ctx) {
  const { proj, base, list, row, rec, n, flat, fullRun, enabledDefault, allDefault } = ctx;
  const version = installedVersion(proj);
  if (!atLeast(version, PROFILE_SINCE)) {
    rec.note(
      `browxai ${version ?? "unknown"} has no toolProfile (added in ${PROFILE_SINCE}): the core profile rows were skipped`,
    );
    return [];
  }
  const coreEnv = { BROWX_TOOL_PROFILE: "core" };
  const coreRun = await list(coreEnv);
  const coreAllRun = await list({ ...coreEnv, BROWX_TOOL_LIST: "all" });
  const core = row("core (enabled)", "default 4", coreRun);
  row("core + all", "default 4", coreAllRun);
  if (!core) {
    rec.diff("BROWX_TOOL_PROFILE=core: the server did not start with the default capabilities");
    return [];
  }

  // The same set with toolList all: under the default capabilities every core tool is on, so all adds nothing.
  if (coreAllRun.ok) {
    const names = (r) => new Set(r.tools.map((t) => t.name));
    const a = names(coreRun);
    const b = names(coreAllRun);
    const apart = [...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x)));
    if (apart.length)
      rec.diff(
        `core lists ${a.size} tools with toolList enabled and ${b.size} with all (differ: ${apart.slice(0, 4).join(", ")}): the RFC says the same set`,
      );
  }
  if (fullRun.tools.some((t) => t.name === CATALOG))
    rec.diff(`the default listing has ${CATALOG}: the docs say it exists only under core`);

  const lines = [];
  const coreNames = await installedCoreNames(proj);
  const parts = coreNames ? splitCore(coreRun.tools, coreNames) : undefined;
  if (parts) {
    const listed = new Set(coreRun.tools.map((t) => t.name));
    const missing = coreNames.filter((x) => !listed.has(x));
    if (missing.length) rec.diff(`the core listing lacks core tools: ${missing.join(", ")}`);
    if (coreNames.length !== CORE_TOOL_COUNT)
      rec.diff(
        `the installed core set has ${coreNames.length} tools, the docs say ${CORE_TOOL_COUNT}`,
      );
    if (parts.catalog === undefined) rec.diff(`the core listing has no ${CATALOG} tool`);
    const plugins = parts.plugin.length
      ? `${parts.plugin.length} (${parts.plugin
          .slice(0, 4)
          .map((p) => `${p.name} ${n(p.chars)}`)
          .join(", ")}${parts.plugin.length > 4 ? ", ..." : ""})`
      : "0";
    lines.push({
      head: `core split: ${parts.core.count} core tools ${n(parts.core.chars)} chars, plugin tools ${plugins}, ${CATALOG} ${parts.catalog === undefined ? "absent" : `${n(parts.catalog)} chars`}`,
    });
  } else {
    rec.note("could not read the package's core tool list, so the core split was skipped");
  }

  // Ratios and the two documented limits.
  if (enabledDefault && allDefault) {
    lines.unshift({
      head: `core vs default listing ${pct(core.chars, enabledDefault.chars)}%, vs all ${pct(core.chars, allDefault.chars)}% (chars), ${enabledDefault.count - core.count} fewer tools than default`,
    });
  }
  if (enabledDefault && core.chars >= CORE_SHARE_LIMIT * enabledDefault.chars)
    rec.diff(
      `the core listing is ${pct(core.chars, enabledDefault.chars)}% of the default listing, the roadmap says under ${CORE_SHARE_LIMIT * 100}%`,
    );
  const off = Math.round(((core.chars - RFC_CORE_CHARS) / RFC_CORE_CHARS) * 100);
  rec.note(
    `core listing is ${n(core.chars)} chars (~${n(estTokens(core.chars))} tok est), RFC 0010 estimated about ${n(RFC_CORE_CHARS)}: ${Math.abs(off)}% ${off < 0 ? "below" : "above"} the estimate`,
  );

  // One tool_catalog call over stdio.
  const reply = await catalogReply({ ...base, ...coreEnv }, proj, flat);
  if (reply.ok) {
    lines.push({
      head: `${CATALOG} reply: ${n(reply.chars)} chars (~${n(estTokens(reply.chars))} tok est), ${reply.omitted ?? "?"} tools named, RFC 0010 estimated about ${n(RFC_CATALOG_REPLY_CHARS)}`,
    });
  } else {
    rec.diff(`${CATALOG} call failed: ${reply.error}`);
  }
  return lines;
}
