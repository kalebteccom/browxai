// `browxai runtime config`: read and set the owner's settings in
// `<runtime>/runtime.json`. With no setting it prints each one with where its
// value comes from. With one it writes that key. `config` and `install` are the
// only writers of runtime.json; no workspace config, `set_config` or MCP tool
// reaches it. A value outside the listed words is a usage error and writes
// nothing, and a runtime.json that doesn't parse is left alone.

import type { RuntimePaths } from "./runtime-layout.js";
import {
  CHANNELS,
  MAX_COOLDOWN_HOURS,
  readSettingsFile,
  resolveAutoUpdate,
  resolveChannel,
  resolveCooldown,
  writeSettingsFile,
  type Channel,
} from "./runtime-settings.js";

/** One setting `runtime config` writes. */
export type ConfigChange =
  | { key: "auto-update"; value: "on" | "off" }
  | { key: "channel"; value: Channel }
  | { key: "cooldown-hours"; value: number };

/** `runtime config` arguments: none to read, or a key and its value. */
export function parseConfigArgs(rest: readonly string[]): ConfigChange | null | undefined {
  if (rest.length === 0) return null;
  if (rest.length !== 2) return undefined;
  const [key, value] = rest as [string, string];
  if (key === "auto-update" && (value === "on" || value === "off")) return { key, value };
  if (key === "channel" && (CHANNELS as readonly string[]).includes(value)) {
    return { key, value: value as Channel };
  }
  if (key === "cooldown-hours" && /^\d+$/.test(value)) {
    const hours = Number(value);
    if (hours <= MAX_COOLDOWN_HOURS) return { key, value: hours };
  }
  return undefined;
}

export interface ConfigIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Print every setting with its source. Exit 0, or 1 when a value is not usable. */
function show(paths: RuntimePaths, env: NodeJS.ProcessEnv, io: ConfigIo): number {
  const { file, error } = readSettingsFile(paths);
  const channel = resolveChannel(env, file);
  const auto = resolveAutoUpdate(env, file, error);
  const cooldown = resolveCooldown(file);
  const lines = [
    `runtime settings (${paths.settings})`,
    `  channel:        ${channel.ok ? `${channel.value} (${channel.source})` : "not usable"}`,
    `  auto-update:    ${auto.on ? "on" : "off"} (${auto.source})`,
    `  cooldown-hours: ${cooldown.hours} (${cooldown.source})`,
  ];
  io.out(lines.join("\n") + "\n");
  const problems = [
    error,
    channel.ok ? undefined : channel.error,
    auto.warning,
    cooldown.warning,
  ].filter((p): p is string => !!p);
  for (const p of problems) io.err(`warning: ${p}\n`);
  return problems.length ? 1 : 0;
}

/** The variable that overrides `change` in this environment, if one does. */
function envOverride(change: ConfigChange, env: NodeJS.ProcessEnv): string | undefined {
  if (change.key === "channel") {
    const v = env.BROWX_RUNTIME_CHANNEL?.trim();
    return v && v !== change.value ? `BROWX_RUNTIME_CHANNEL=${v}` : undefined;
  }
  if (change.key === "auto-update" && change.value === "on") {
    const raw = env.BROWX_RUNTIME_AUTO_UPDATE;
    if (raw?.trim() && !resolveAutoUpdate({ BROWX_RUNTIME_AUTO_UPDATE: raw }, {}).on) {
      return `BROWX_RUNTIME_AUTO_UPDATE=${raw.trim()}`;
    }
  }
  return undefined;
}

export function runConfig(
  paths: RuntimePaths,
  change: ConfigChange | null,
  env: NodeJS.ProcessEnv,
  io: ConfigIo,
): number {
  if (change === null) return show(paths, env, io);
  const { error } = readSettingsFile(paths);
  if (error) {
    io.err(`browxai runtime: ${error}. Fix it or remove it. Nothing was changed.\n`);
    return 2;
  }
  if (change.key === "auto-update") writeSettingsFile(paths, { autoUpdate: change.value });
  if (change.key === "channel") writeSettingsFile(paths, { channel: change.value });
  if (change.key === "cooldown-hours") writeSettingsFile(paths, { cooldownHours: change.value });
  io.out(`✓ ${change.key} is ${change.value} in ${paths.settings}\n`);
  const override = envOverride(change, env);
  if (override) {
    io.err(
      `warning: ${override} is set in this environment and wins over runtime.json here. ` +
        "The background job reads its own environment.\n",
    );
  }
  return 0;
}
