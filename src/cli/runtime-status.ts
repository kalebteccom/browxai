// `browxai runtime status`: what the runtime directory holds and who uses it. It
// reads files and the process list and makes no network call. `--json` prints the
// same facts as one JSON document.

import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { PACKAGE_VERSION } from "../util/version.js";
import type { RuntimeInspection, RuntimePaths } from "./runtime-layout.js";
import { versionsInUse, type ProcessLister } from "./runtime-gc.js";
import {
  resolveAutoUpdate,
  resolveChannel,
  readSettingsFile,
  type SettingSource,
} from "./runtime-settings.js";
import {
  listVersions,
  readCurrent,
  readNodePath,
  readState,
  type PendingUpdate,
} from "./runtime-store.js";

export interface RuntimeStatus {
  dir: string;
  /** `absent` and `empty` mean nothing is installed there yet. */
  layout: RuntimeInspection["kind"];
  schemaVersion?: number;
  current?: string;
  previous?: string;
  /** The browxai answering this command, and whether it runs from this runtime. */
  process: { version: string; fromRuntime: boolean };
  channel: { value?: string; source?: SettingSource; error?: string };
  autoUpdate: { on: boolean; source: SettingSource; warning?: string };
  node: { path?: string; exists: boolean };
  versions: Array<{ version: string; current: boolean; previous: boolean; pids: number[] }>;
  /** False when the process list couldn't be read, so `pids` is empty for all. */
  pidsKnown: boolean;
  /** The background job's files that exist; empty when no job is installed. */
  agent: string[];
  lastCheck?: string;
  nextCheck?: string;
  lastResult?: string;
  pending?: PendingUpdate;
}

export interface StatusDeps {
  env: NodeJS.ProcessEnv;
  list: ProcessLister;
  /** The real path of the `cli.js` this process runs. */
  selfCli: string;
  /** The background job's files that exist. */
  agentInstalled?: () => string[];
}

export async function runtimeStatus(
  paths: RuntimePaths,
  found: RuntimeInspection,
  deps: StatusDeps,
): Promise<RuntimeStatus> {
  const { file, error } = readSettingsFile(paths);
  const channel = resolveChannel(deps.env, file);
  const base: RuntimeStatus = {
    dir: paths.root,
    layout: found.kind,
    process: { version: PACKAGE_VERSION, fromRuntime: runsFrom(paths, deps.selfCli) },
    channel: channel.ok
      ? { value: channel.value, source: channel.source }
      : { error: channel.error },
    autoUpdate: resolveAutoUpdate(deps.env, file, error),
    node: { exists: false },
    versions: [],
    pidsKnown: true,
    agent: deps.agentInstalled?.() ?? [],
  };
  if (found.kind !== "managed") return base;
  const current = readCurrent(paths);
  const { previous, lastCheck, nextCheck, lastResult, pending } = readState(paths);
  const node = readNodePath(paths);
  const use = await versionsInUse(paths, deps.list);
  return {
    ...base,
    schemaVersion: found.schemaVersion,
    ...(current ? { current } : {}),
    ...(previous ? { previous } : {}),
    node: { ...(node ? { path: node } : {}), exists: !!node && existsSync(node) },
    versions: listVersions(paths).map((v) => ({
      version: v,
      current: v === current,
      previous: v === previous,
      pids: use?.get(v) ?? [],
    })),
    pidsKnown: use !== undefined,
    ...(lastCheck ? { lastCheck } : {}),
    ...(nextCheck ? { nextCheck } : {}),
    ...(lastResult ? { lastResult } : {}),
    ...(pending ? { pending } : {}),
  };
}

/** Whether `cli` sits under this runtime's `versions/`. */
function runsFrom(paths: RuntimePaths, cli: string): boolean {
  let root: string;
  try {
    root = realpathSync(paths.root);
  } catch {
    return false;
  }
  return cli.startsWith(join(root, "versions") + sep);
}

export function renderStatus(s: RuntimeStatus): string {
  if (s.layout === "absent" || s.layout === "empty") {
    return `No browxai runtime at ${s.dir}. Run: browxai runtime install\n`;
  }
  const lines = [`browxai runtime at ${s.dir}`];
  if (s.schemaVersion !== undefined && s.schemaVersion !== 1) {
    lines.push(
      `  ⚠ layout.json has schemaVersion ${s.schemaVersion}: a newer browxai manages this runtime`,
    );
  }
  lines.push(`  current:      ${s.current ?? "none. Run: browxai runtime install"}`);
  if (s.previous) lines.push(`  previous:     ${s.previous}`);
  const here = s.process.fromRuntime ? "runs from this runtime" : "does not run from this runtime";
  lines.push(`  this browxai: ${s.process.version}, ${here}`);
  if (s.process.fromRuntime && s.current && s.current !== s.process.version) {
    lines.push(
      `  ⚠ this process runs ${s.process.version}, current is ${s.current}. Restart the MCP client to pick it up`,
    );
  }
  lines.push(
    `  channel:      ${s.channel.value ? `${s.channel.value} (${s.channel.source})` : `✗ ${s.channel.error}`}`,
  );
  lines.push(`  auto-update:  ${s.autoUpdate.on ? "on" : "off"} (${s.autoUpdate.source})`);
  if (s.autoUpdate.warning) lines.push(`  ⚠ ${s.autoUpdate.warning}`);
  lines.push(
    s.agent.length
      ? `  job:          ${s.agent.join(", ")}`
      : "  job:          none installed. Updates run when you run browxai runtime update",
  );
  lines.push(...scheduleLines(s));
  if (!s.node.path) lines.push("  node:         not recorded. Run: browxai runtime install");
  else if (!s.node.exists)
    lines.push(`  ⚠ the recorded node at ${s.node.path} is gone. Run browxai runtime install`);
  else lines.push(`  node:         ${s.node.path}`);
  lines.push("  versions:");
  for (const v of s.versions) lines.push(`    ${versionLine(v, s.pidsKnown)}`);
  if (s.versions.length === 0) lines.push("    none");
  return lines.join("\n") + "\n";
}

function versionLine(v: RuntimeStatus["versions"][number], pidsKnown: boolean): string {
  const tags = [v.current ? "current" : "", v.previous ? "previous" : ""].filter(Boolean);
  const pids = !pidsKnown
    ? "in use: unknown"
    : v.pids.length
      ? `in use by pid ${v.pids.join(", ")}`
      : "";
  return [v.version.padEnd(12), tags.join(", "), pids].filter(Boolean).join("  ").trimEnd();
}

function scheduleLines(s: RuntimeStatus): string[] {
  const lines: string[] = [];
  lines.push(
    `  last check:   ${s.lastCheck ?? "never"}${s.lastResult ? ` (${s.lastResult})` : ""}`,
  );
  if (s.nextCheck) lines.push(`  next check:   ${s.nextCheck}`);
  const p = s.pending;
  if (p) {
    const why =
      p.state === "waiting"
        ? `waits until ${p.until}`
        : `${p.state}${p.reason ? `: ${p.reason}` : ""}`;
    lines.push(`  pending:      ${p.version}, ${why}`);
  }
  return lines;
}
