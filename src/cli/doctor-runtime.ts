// `browxai doctor` runtime row: whether this browxai runs from a runtime
// directory (RFC 0015), and if so the version `current` names, the channel, the
// last and next check, and any update that waits. It reads `state.json`,
// `current`, `runtime.json`, `node-path` and `updater-errors` and makes no
// network call.
//
// The row is informational. It warns about an update that waits or is held (a
// new major version, a Node engines range the runtime's node misses, a
// Playwright bump on a machine with no Google Chrome, a rollback), a
// deprecated `current`, a missing node, a missing background job, unread
// Upgrading notes or an updater that keeps failing, and it never
// changes the exit code, with one exception: a version that failed signature or
// provenance verification is a ✗, because that points at the supply chain.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../util/version.js";
import type { Check } from "./doctor.js";
import { runningAppBundle } from "./macos-app.js";
import { agentFiles } from "./runtime-agent.js";
import { compareVersions, runtimePaths, type RuntimePaths } from "./runtime-layout.js";
import { readSettingsFile, resolveAutoUpdate, resolveChannel } from "./runtime-settings.js";
import { readCurrent, readNodePath, readState, type RuntimeState } from "./runtime-store.js";

export interface RuntimeRowDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** The real path of the `cli.js` this process runs. */
  selfCli?: string;
  /** The browxai version this process runs. */
  version?: string;
  appBundle?: () => string | undefined;
  now?: () => number;
  /** The background job's files that exist. */
  agentInstalled?: () => string[];
}

const RUNTIME_CLI =
  /^(.*)[\\/]versions[\\/][^\\/]+[\\/]node_modules[\\/]browxai[\\/]dist[\\/]cli\.js$/;

const VERIFICATION_FAILED = "verification failed";

function selfCliPath(): string {
  const path = fileURLToPath(new URL("../cli.js", import.meta.url));
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The runtime this process runs from: the launcher's BROWX_RUNTIME_DIR, or the
 *  directory above `versions/` in the real path of `cli.js`. */
function runtimeRoot(selfCli: string, env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.BROWX_RUNTIME_DIR?.trim();
  const candidates = [fromEnv, RUNTIME_CLI.exec(selfCli)?.[1]];
  return candidates.find((c) => !!c && existsSync(runtimePaths(c).layout));
}

/** "2h", "15m", "3d". */
export function span(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

interface Facts {
  paths: RuntimePaths;
  state: RuntimeState;
  current: string | undefined;
  version: string;
  now: number;
}

/** The ✗ case: a version newer than `current` held because verification failed. */
function verificationFailure(f: Facts): string | undefined {
  for (const [v, reason] of Object.entries(f.state.held ?? {})) {
    if (reason !== VERIFICATION_FAILED) continue;
    if (f.current && safeCompare(v, f.current) <= 0) continue;
    return v;
  }
  return undefined;
}

function safeCompare(a: string, b: string): number {
  try {
    return compareVersions(a, b);
  } catch {
    return 0;
  }
}

/** Every warning that applies, most pressing first. */
function warnings(
  f: Facts,
  deps: Required<Pick<RuntimeRowDeps, "agentInstalled">>,
  autoOn: boolean,
): string[] {
  const out: string[] = [];
  const { state, current } = f;
  if (current && safeCompare(f.version, current) < 0) {
    out.push(
      `this process runs ${f.version}, current is ${current}. Restart the MCP client to pick it up`,
    );
  }
  const p = state.pending;
  const newer = !!p && (!current || safeCompare(p.version, current) > 0);
  // A hold (a new major version, a Node engines range, a Playwright bump, a
  // rollback) shows with auto-update off too: a manual update stops on it as well.
  if (p && newer && p.state === "held")
    out.push(`${p.version} available, held: ${p.reason ?? "no reason recorded"}`);
  if (p && newer && autoOn) {
    if (p.state === "waiting" && p.until)
      out.push(`${p.version} available, waits until ${p.until}`);
    if (p.state === "limit") out.push(`${p.version} available, waits for the daily apply limit`);
    if (p.state === "failed") {
      const n = state.failed?.[p.version] ?? 1;
      out.push(
        `${p.version} failed its checks ${n === 1 ? "once" : `${n} times`} (${p.reason ?? "no reason recorded"}). current stays ${current ?? "unset"}`,
      );
    }
  }
  const updater = updaterLine(f);
  if (updater) out.push(updater);
  if (state.notesUnseen?.length) {
    out.push(`Upgrading notes for ${state.notesUnseen.join(", ")}: browxai runtime notes`);
  }
  if (current && state.currentDeprecated) {
    out.push(`${current} is deprecated: "${state.currentDeprecated}". Run browxai runtime update`);
  }
  const node = readNodePath(f.paths);
  if (node && !existsSync(node))
    out.push(`the recorded node at ${node} is gone. Run browxai runtime install`);
  if (autoOn && deps.agentInstalled().length === 0) {
    out.push("auto-update is on, but no background job is installed. Run browxai runtime install");
  }
  return out;
}

/** The background job's updater errors, which the launcher counts in
 *  `updater-errors` (RFC 0015, D19). Undefined while it succeeds. */
function updaterLine(f: Facts): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(f.paths.updaterErrors, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  const v = f.current ?? "current";
  if (n === 0) {
    return `the updater in ${v} exited with an error 3 runs in a row, so the background job ran the previous version's updater once. See ${f.paths.journal}`;
  }
  const runs = n === 1 ? "its last run" : `its last ${n} runs`;
  const next = !f.state.previous
    ? "There is no previous version to fall back to. Run browxai runtime update to see the error"
    : n >= 3
      ? "The next run uses the previous version's updater"
      : "After 3 in a row the background job runs the previous version's updater once";
  return `the updater in ${v} exited with an error on ${runs}. ${next}`;
}

function summary(f: Facts, channel: string, autoOn: boolean, autoSource: string): string {
  // A prerelease from the next channel stays after a switch back to latest: the
  // updater never moves down, so it waits for a release newer than it.
  const prerelease = channel === "latest" && !!f.current?.includes("-");
  const parts = [
    `${f.current ?? "no current version"} (channel ${channel}${prerelease ? ", a prerelease kept until latest passes it" : ""})`,
  ];
  const last = f.state.lastCheck ? Date.parse(f.state.lastCheck) : NaN;
  parts.push(Number.isNaN(last) ? "never checked" : `checked ${span(f.now - last)} ago`);
  const next = f.state.nextCheck ? Date.parse(f.state.nextCheck) : NaN;
  if (autoOn && !Number.isNaN(next)) {
    parts.push(
      next > f.now ? `next check in ~${span(next - f.now)}` : "next check at the next hourly run",
    );
  }
  parts.push(`auto-update ${autoOn ? "on" : "off"} (${autoSource})`);
  return parts.join(", ");
}

export function runtimeRow(deps: RuntimeRowDeps = {}): Check {
  const env = deps.env ?? process.env;
  if ((deps.appBundle ?? runningAppBundle)() !== undefined) {
    return {
      name: "runtime",
      ok: true,
      info: true,
      detail: "signed app. Updates through Homebrew: brew upgrade --cask browxai",
    };
  }
  const selfCli = deps.selfCli ?? selfCliPath();
  const root = runtimeRoot(selfCli, env);
  if (!root) {
    return {
      name: "runtime",
      ok: true,
      info: true,
      detail: `not running from a browxai runtime. Client entries that name ${selfCli} don't update`,
      enable: "browxai runtime install",
    };
  }
  const paths = runtimePaths(root);
  const facts: Facts = {
    paths,
    state: readState(paths),
    current: readCurrent(paths),
    version: deps.version ?? PACKAGE_VERSION,
    now: (deps.now ?? Date.now)(),
  };
  const { file, error } = readSettingsFile(paths);
  const auto = resolveAutoUpdate(env, file, error);
  const channel = resolveChannel(env, file);
  const base = summary(facts, channel.ok ? channel.value : "unknown", auto.on, auto.source);
  const failedVerification = verificationFailure(facts);
  if (failedVerification) {
    return {
      name: "runtime",
      ok: false,
      detail: `${failedVerification} failed signature or provenance verification and is held. ${base}`,
      fix: `current stays ${facts.current ?? "unset"}. See browxai runtime status and ${paths.journal}`,
    };
  }
  const home = deps.home ?? homedir();
  const agentInstalled =
    deps.agentInstalled ??
    (() =>
      agentFiles({ platform: deps.platform ?? process.platform, home, env }).filter((f) =>
        existsSync(f),
      ));
  const warn = warnings(facts, { agentInstalled }, auto.on);
  if (!channel.ok) warn.unshift(channel.error);
  if (auto.warning) warn.unshift(auto.warning);
  if (warn.length > 0) {
    return {
      name: "runtime",
      ok: true,
      warn: true,
      detail: `${warn[0]}. ${base}`,
      ...(warn.length > 1 ? { fix: warn.slice(1).join("; ") } : {}),
    };
  }
  if (!auto.on)
    return { name: "runtime", ok: true, info: true, detail: offLine(facts, auto.source) };
  return { name: "runtime", ok: true, detail: base };
}

/** Auto-update off, with the version a cached check found, when there is one. */
function offLine(f: Facts, source: string): string {
  const p = f.state.pending;
  const available =
    p && (!f.current || safeCompare(p.version, f.current) > 0) ? `. ${p.version} available` : "";
  return `${f.current ?? "no current version"}, auto-update off (${source})${available}`;
}
