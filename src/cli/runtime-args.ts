// `browxai runtime`: the argument grammar of each verb. Anything else is a usage
// error, exit 2.

import { isVersion } from "./runtime-layout.js";
import { isChannel, type Channel } from "./runtime-settings.js";

export type RuntimeArgs =
  | { verb: "status"; json: boolean }
  | { verb: "rollback" }
  | { verb: "gc" }
  | {
      verb: "install";
      dir?: string;
      channel?: Channel;
      writeClientConfig: boolean;
      profileDirs: string[];
      /** `--no-agent`: install no background job. */
      noAgent: boolean;
    }
  | { verb: "update"; check: boolean; version?: string; auto: boolean; now: boolean }
  | { verb: "uninstall"; yes: boolean };

export const RUNTIME_USAGE =
  "usage: browxai runtime <install|update|status|rollback|gc|uninstall> [flags]\n" +
  "  install [--dir PATH] [--channel latest|next] [--no-agent] [--write-client-config]\n" +
  "          [--profile-dir DIR]...\n" +
  "                    create the runtime directory, record this node, write the\n" +
  "                    launcher <runtime>/bin/browxai, install the channel's version\n" +
  "                    as update does, then install the background job that runs\n" +
  "                    update --auto every hour (launchd on macOS, a systemd user\n" +
  "                    timer on Linux). --no-agent skips the job. Prints the client entries.\n" +
  "                    --write-client-config rewrites entries that run an installed\n" +
  "                    browxai or npx browxai in the active config of each client.\n" +
  "                    --profile-dir DIR adds one more config directory, once per DIR.\n" +
  "  update [--check] [--version V] [--now] [--auto]\n" +
  "                    install the channel's newest version, or V, into staging, check\n" +
  "                    its npm signatures, run it once (--version, MCP handshake,\n" +
  "                    doctor, runtime status), then switch current to it. --check\n" +
  "                    downloads nothing. --auto is the background job's mode: a\n" +
  "                    check every 6 hours, a 24-hour delay after publish, limits,\n" +
  "                    backoff when offline, and exit 0 unless an internal error.\n" +
  "                    --now skips the delay.\n" +
  "  status [--json]   the runtime directory, the version `current` names, the kept\n" +
  "                    versions and the processes that use them. No network.\n" +
  "  rollback          switch `current` back to the previous version. No network.\n" +
  "  gc                keep three versions (current, previous and one more) and\n" +
  "                    remove older ones that no running process uses\n" +
  "  uninstall [--yes] remove the background job and the runtime directory. Refuses\n" +
  "                    while a process uses a version, unless --yes.\n" +
  "The runtime directory is $BROWX_RUNTIME_DIR, or ~/.browxai-runtime.\n" +
  "Exit 0 ok, 1 a failed check or an internal error, 2 usage or a refused context,\n" +
  "3 the npm registry could not be reached.\n";

type Flags = Map<string, string | true>;

/** `--flag` and `--flag VALUE` pairs. Undefined for an unknown flag, a missing
 *  value, a positional word or a repeated flag. `--profile-dir` may repeat. */
function readFlags(
  rest: readonly string[],
  spec: Record<string, "bool" | "value">,
): { flags: Flags; profileDirs: string[] } | undefined {
  const flags: Flags = new Map();
  const profileDirs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const kind = spec[a];
    if (!kind) return undefined;
    if (kind === "bool") {
      if (flags.has(a)) return undefined;
      flags.set(a, true);
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) return undefined;
    if (a === "--profile-dir") profileDirs.push(value);
    else if (flags.has(a)) return undefined;
    else flags.set(a, value);
  }
  return { flags, profileDirs };
}

const str = (f: Flags, k: string): string | undefined => {
  const v = f.get(k);
  return typeof v === "string" ? v : undefined;
};

function parseInstall(rest: readonly string[]): RuntimeArgs | undefined {
  const r = readFlags(rest, {
    "--dir": "value",
    "--channel": "value",
    "--write-client-config": "bool",
    "--profile-dir": "value",
    "--no-agent": "bool",
  });
  if (!r) return undefined;
  const channel = str(r.flags, "--channel");
  if (channel !== undefined && !isChannel(channel)) return undefined;
  const writeClientConfig = r.flags.has("--write-client-config");
  // A profile directory is written only as part of the rewrite.
  if (r.profileDirs.length > 0 && !writeClientConfig) return undefined;
  const dir = str(r.flags, "--dir");
  return {
    verb: "install",
    ...(dir !== undefined ? { dir } : {}),
    ...(channel !== undefined ? { channel } : {}),
    writeClientConfig,
    profileDirs: r.profileDirs,
    noAgent: r.flags.has("--no-agent"),
  };
}

function parseUpdate(rest: readonly string[]): RuntimeArgs | undefined {
  // `--now` skips the delay after publish, which a manual run never waits for.
  const r = readFlags(rest, {
    "--check": "bool",
    "--version": "value",
    "--now": "bool",
    "--auto": "bool",
  });
  if (!r) return undefined;
  const version = str(r.flags, "--version");
  if (version !== undefined && !isVersion(version)) return undefined;
  const auto = r.flags.has("--auto");
  // The background job applies the channel's version; it never checks only or pins one.
  if (auto && (version !== undefined || r.flags.has("--check"))) return undefined;
  return {
    verb: "update",
    check: r.flags.has("--check"),
    ...(version !== undefined ? { version } : {}),
    auto,
    now: r.flags.has("--now"),
  };
}

export function parseRuntimeArgs(args: readonly string[]): RuntimeArgs | undefined {
  const [verb, ...rest] = args;
  switch (verb) {
    case "status":
      if (rest.length === 0) return { verb, json: false };
      return rest.length === 1 && rest[0] === "--json" ? { verb, json: true } : undefined;
    case "rollback":
    case "gc":
      return rest.length === 0 ? { verb } : undefined;
    case "install":
      return parseInstall(rest);
    case "update":
      return parseUpdate(rest);
    case "uninstall": {
      const r = readFlags(rest, { "--yes": "bool" });
      return r ? { verb, yes: r.flags.has("--yes") } : undefined;
    }
    default:
      return undefined;
  }
}
