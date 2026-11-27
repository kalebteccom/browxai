// `browxai runtime`: the owner's settings. They come from `BROWX_RUNTIME_*`
// variables or from `<runtime>/runtime.json`, never from the workspace config,
// `set_config` or an MCP tool, so an agent with tool access can't switch the
// channel or turn updates back on. A value this code doesn't know fails closed:
// an unknown channel is refused, an unknown auto-update value means off.

import { readFileSync } from "node:fs";
import type { RuntimePaths } from "./runtime-layout.js";
import { writeFileAtomic } from "./runtime-store.js";

export const CHANNELS = ["latest", "next"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Where a setting's value came from, as `status` prints it. */
export type SettingSource =
  "BROWX_RUNTIME_CHANNEL" | "BROWX_RUNTIME_AUTO_UPDATE" | "runtime.json" | "default";

export interface SettingsFile {
  channel?: unknown;
  autoUpdate?: unknown;
  [key: string]: unknown;
}

/** `runtime.json`. `error` is set when the file exists and isn't a JSON object. */
export function readSettingsFile(paths: RuntimePaths): { file: SettingsFile; error?: string } {
  let text: string;
  try {
    text = readFileSync(paths.settings, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { file: {} };
    return { file: {}, error: `${paths.settings} can't be read` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return { file: parsed as SettingsFile };
  } catch {
    return { file: {}, error: `${paths.settings} is not a JSON object` };
  }
}

/** Merge `patch` into `runtime.json`, mode 0600. */
export function writeSettingsFile(paths: RuntimePaths, patch: SettingsFile): void {
  const { file } = readSettingsFile(paths);
  writeFileAtomic(paths.settings, JSON.stringify({ ...file, ...patch }, null, 2) + "\n");
}

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

export type ChannelSetting =
  { ok: true; value: Channel; source: SettingSource } | { ok: false; error: string };

/** The channel: the variable, then `runtime.json`, then `latest`. */
export function resolveChannel(env: NodeJS.ProcessEnv, file: SettingsFile): ChannelSetting {
  const fromEnv = env.BROWX_RUNTIME_CHANNEL?.trim();
  if (fromEnv) {
    if (isChannel(fromEnv)) return { ok: true, value: fromEnv, source: "BROWX_RUNTIME_CHANNEL" };
    return {
      ok: false,
      error: `BROWX_RUNTIME_CHANNEL=${fromEnv} is not a channel. Use ${CHANNELS.join(" or ")}.`,
    };
  }
  if (file.channel !== undefined) {
    if (typeof file.channel === "string" && isChannel(file.channel)) {
      return { ok: true, value: file.channel, source: "runtime.json" };
    }
    return {
      ok: false,
      error: `"channel" in runtime.json is ${JSON.stringify(file.channel)}, not a channel. Use ${CHANNELS.join(" or ")}.`,
    };
  }
  return { ok: true, value: "latest", source: "default" };
}

const ON_WORDS = ["on", "1", "true", "yes"];
const OFF_WORDS = ["off", "0", "false", "no"];

/** One auto-update value: true, false, or undefined for a value this code doesn't know. */
function parseSwitch(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const word = value.trim().toLowerCase();
  if (ON_WORDS.includes(word)) return true;
  if (OFF_WORDS.includes(word)) return false;
  return undefined;
}

export interface AutoUpdateSetting {
  on: boolean;
  source: SettingSource;
  /** Set when a value was not understood and counted as off. */
  warning?: string;
}

/**
 * Whether the background job may update. Off in the variable or in `runtime.json`
 * wins over on in the other, and a value outside `on|1|true|yes|off|0|false|no`
 * counts as off with a warning.
 */
export function resolveAutoUpdate(
  env: NodeJS.ProcessEnv,
  file: SettingsFile,
  fileError?: string,
): AutoUpdateSetting {
  const raw = env.BROWX_RUNTIME_AUTO_UPDATE;
  if (raw !== undefined && raw.trim() !== "") {
    const v = parseSwitch(raw);
    if (v === undefined) {
      return {
        on: false,
        source: "BROWX_RUNTIME_AUTO_UPDATE",
        warning: `BROWX_RUNTIME_AUTO_UPDATE=${raw.trim()} is not on or off, so auto-update is off`,
      };
    }
    if (!v) return { on: false, source: "BROWX_RUNTIME_AUTO_UPDATE" };
  }
  if (fileError)
    return { on: false, source: "runtime.json", warning: `${fileError}, so auto-update is off` };
  if (file.autoUpdate !== undefined) {
    const v = parseSwitch(file.autoUpdate);
    if (v === undefined) {
      return {
        on: false,
        source: "runtime.json",
        warning: `"autoUpdate" in runtime.json is ${JSON.stringify(file.autoUpdate)}, not on or off, so auto-update is off`,
      };
    }
    if (!v) return { on: false, source: "runtime.json" };
    return { on: true, source: "runtime.json" };
  }
  return { on: true, source: raw?.trim() ? "BROWX_RUNTIME_AUTO_UPDATE" : "default" };
}

export const DEFAULT_COOLDOWN_HOURS = 24;
export const MAX_COOLDOWN_HOURS = 24 * 30;

export interface CooldownSetting {
  hours: number;
  source: SettingSource;
  /** Set when `cooldownHours` was not understood and the default applies. */
  warning?: string;
}

/**
 * The delay after publish the background job waits before it applies a version:
 * `cooldownHours` in `runtime.json`, else 24. A value that isn't a number from 0
 * to 720 keeps the 24-hour delay, with a warning.
 */
export function resolveCooldown(file: SettingsFile): CooldownSetting {
  const raw = file.cooldownHours;
  if (raw === undefined) return { hours: DEFAULT_COOLDOWN_HOURS, source: "default" };
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= MAX_COOLDOWN_HOURS) {
    return { hours: raw, source: "runtime.json" };
  }
  return {
    hours: DEFAULT_COOLDOWN_HOURS,
    source: "default",
    warning: `"cooldownHours" in runtime.json is ${JSON.stringify(raw)}, not a number of hours from 0 to ${MAX_COOLDOWN_HOURS}, so the delay is ${DEFAULT_COOLDOWN_HOURS} hours`,
  };
}
