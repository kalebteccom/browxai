// `browxai runtime`: the argument grammar of each verb. Anything else is a usage
// error, exit 2.

import { parseConfigArgs, type ConfigChange } from "./runtime-config.js";
import { isVersion } from "./runtime-layout.js";
import { isChannel, type Channel } from "./runtime-settings.js";

export type RuntimeArgs =
  | { verb: "status"; json: boolean }
  /** `rollback [--to V]`: back to `previous`, or to the kept version V. */
  | { verb: "rollback"; to?: string }
  | { verb: "gc" }
  | {
      verb: "install";
      dir?: string;
      channel?: Channel;
      writeClientConfig: boolean;
      profileDirs: string[];
      /** `--no-agent`: install no background job. */
      noAgent: boolean;
      /** `--link`: symlink the launcher into ~/.local/bin. */
      link: boolean;
    }
  | {
      verb: "update";
      check: boolean;
      version?: string;
      auto: boolean;
      now: boolean;
      /** `--allow-major`: apply a new major version this once (D7). */
      allowMajor: boolean;
    }
  /** `--keep-versions`: remove everything but `versions/` and `layout.json`. */
  | { verb: "uninstall"; yes: boolean; keepVersions: boolean }
  /** `notes [V]`: the Upgrading notes of V, or the unread ones. */
  | { verb: "notes"; version?: string }
  /** `config`: null reads every setting, a change writes one. */
  | { verb: "config"; change: ConfigChange | null };

export const RUNTIME_USAGE =
  "usage: browxai runtime <install|update|status|notes|config|rollback|gc|uninstall> [flags]\n" +
  "  install [--dir PATH] [--channel latest|next] [--no-agent] [--link] [--write-client-config]\n" +
  "          [--profile-dir DIR]...\n" +
  "                    create the runtime directory, record this node, write the\n" +
  "                    launcher <runtime>/bin/browxai, install the channel's version\n" +
  "                    as update does, then install the background job that runs\n" +
  "                    update --auto every hour (launchd on macOS, a systemd user\n" +
  "                    timer on Linux). --no-agent skips the job. Prints the client entries.\n" +
  "                    --link symlinks the launcher as ~/.local/bin/browxai. It never\n" +
  "                    replaces a file there that isn't a link to this launcher.\n" +
  "                    --write-client-config rewrites entries that run an installed\n" +
  "                    browxai or npx browxai in the active config of each client.\n" +
  "                    --profile-dir DIR adds one more config directory, once per DIR.\n" +
  "  update [--check] [--version V] [--allow-major] [--now] [--auto]\n" +
  "                    install the channel's newest version, or V, into staging, check\n" +
  "                    its npm signatures, run it once (--version, MCP handshake,\n" +
  "                    doctor, runtime status), then switch current to it. --check\n" +
  "                    downloads nothing. A held version (a new major version, a Node\n" +
  "                    engines range this node misses, a Playwright bump on a machine\n" +
  "                    with no Google Chrome, or one a rollback left) is applied only\n" +
  "                    when named with --version. --allow-major applies a new major\n" +
  "                    version. --auto is the background job's mode: a check every 6\n" +
  "                    hours, a 24-hour delay after publish, limits, backoff when\n" +
  "                    offline, and exit 0 unless an internal error. --now skips the delay.\n" +
  "  status [--json]   the runtime directory, the version `current` names, the kept\n" +
  "                    versions and the processes that use them. No network.\n" +
  "  notes [V]         the Upgrading notes of version V, or of every version after\n" +
  "                    this one (or the previous one) up to current. No network.\n" +
  "  config [auto-update on|off | channel latest|next | major allow|hold | cooldown-hours N]\n" +
  "                    with no setting, print each setting and where it comes from.\n" +
  "                    With one, write it to runtime.json. BROWX_RUNTIME_CHANNEL and\n" +
  "                    BROWX_RUNTIME_AUTO_UPDATE win over the file, and off in either wins.\n" +
  "                    major allow lets the background job apply a new major version.\n" +
  "                    cooldown-hours is the delay after publish, 0 to 720.\n" +
  "  rollback [--to V] switch `current` back to the previous version, or to the kept\n" +
  "                    version V. The version it leaves is held until a newer one\n" +
  "                    appears or update --version names it. No network.\n" +
  "  gc                keep three versions (current, previous and one more) and\n" +
  "                    remove older ones that no running process uses\n" +
  "  uninstall [--keep-versions] [--yes]\n" +
  "                    remove the background job, the ~/.local/bin link to this\n" +
  "                    launcher and the runtime directory. Refuses while a process\n" +
  "                    uses a version, unless --yes. --keep-versions keeps versions/\n" +
  "                    and layout.json, so servers keep running and a later install\n" +
  "                    reuses them.\n" +
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
    "--link": "bool",
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
    link: r.flags.has("--link"),
  };
}

function parseUpdate(rest: readonly string[]): RuntimeArgs | undefined {
  // `--now` skips the delay after publish, which a manual run never waits for.
  const r = readFlags(rest, {
    "--check": "bool",
    "--version": "value",
    "--now": "bool",
    "--auto": "bool",
    "--allow-major": "bool",
  });
  if (!r) return undefined;
  const version = str(r.flags, "--version");
  if (version !== undefined && !isVersion(version)) return undefined;
  const auto = r.flags.has("--auto");
  const allowMajor = r.flags.has("--allow-major");
  // The background job applies the channel's version; it never checks only or pins
  // one, and it crosses a major version only through `runtime config major allow`.
  if (auto && (version !== undefined || r.flags.has("--check") || allowMajor)) return undefined;
  return {
    verb: "update",
    check: r.flags.has("--check"),
    ...(version !== undefined ? { version } : {}),
    auto,
    now: r.flags.has("--now"),
    allowMajor,
  };
}

export function parseRuntimeArgs(args: readonly string[]): RuntimeArgs | undefined {
  const [verb, ...rest] = args;
  switch (verb) {
    case "status":
      if (rest.length === 0) return { verb, json: false };
      return rest.length === 1 && rest[0] === "--json" ? { verb, json: true } : undefined;
    case "rollback": {
      if (rest.length === 0) return { verb };
      const to = rest[1];
      return rest.length === 2 && rest[0] === "--to" && isVersion(to!)
        ? { verb, to: to! }
        : undefined;
    }
    case "gc":
      return rest.length === 0 ? { verb } : undefined;
    case "install":
      return parseInstall(rest);
    case "update":
      return parseUpdate(rest);
    case "notes":
      if (rest.length === 0) return { verb };
      return rest.length === 1 && isVersion(rest[0]!) ? { verb, version: rest[0]! } : undefined;
    case "config": {
      const change = parseConfigArgs(rest);
      return change === undefined ? undefined : { verb, change };
    }
    case "uninstall": {
      const r = readFlags(rest, { "--yes": "bool", "--keep-versions": "bool" });
      return r
        ? { verb, yes: r.flags.has("--yes"), keepVersions: r.flags.has("--keep-versions") }
        : undefined;
    }
    default:
      return undefined;
  }
}
