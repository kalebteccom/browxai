// `browxai runtime`: the background job that runs `<runtime>/bin/browxai runtime
// update --auto` every hour (RFC 0015, section 7). A launchd user agent on macOS,
// a systemd user timer and service on Linux, nothing elsewhere. It runs as the
// user, in the user's launchd domain or `systemctl --user`, never as root and
// never through sudo.
//
// The job never reads the login shell's PATH. Its PATH is the directory of the
// node the runtime recorded, then /usr/bin and /bin, and BROWX_RUNTIME_NODE names
// that node, so the launcher and npm find the same node under mise, nvm or
// Homebrew.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Runner } from "./runtime-exec.js";
import type { RuntimePaths } from "./runtime-layout.js";
import { writeFileAtomic } from "./runtime-store.js";

export const AGENT_LABEL = "com.kalebtec.browxai.runtime-update";
export const AGENT_UNIT = "browxai-runtime-update";
/** The job wakes this often; `update --auto` decides whether a check is due. */
export const AGENT_INTERVAL_SECONDS = 3600;

const LAUNCHCTL = "/bin/launchctl";

/** What the job needs from the machine. Tests pass a temp home and a fake runner. */
export interface AgentHost {
  platform: NodeJS.Platform;
  home: string;
  uid: number | undefined;
  /** Read for XDG_CONFIG_HOME only. */
  env: NodeJS.ProcessEnv;
  run: Runner;
}

export type AgentKind = "launchd" | "systemd";

export interface AgentResult {
  ok: boolean;
  detail: string;
}

/** Install, remove and find the job. `runtime install` and `uninstall` take it as a seam. */
export interface AgentPort {
  kind: AgentKind | undefined;
  install(paths: RuntimePaths, node: string): Promise<AgentResult>;
  remove(): Promise<AgentResult>;
  /** The job's files that exist now. Empty when it is not installed. */
  installed(): string[];
}

export function agentKind(platform: NodeJS.Platform): AgentKind | undefined {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return undefined;
}

/** The job's files: the plist on macOS, the service and timer on Linux. */
export function agentFiles(host: Pick<AgentHost, "platform" | "home" | "env">): string[] {
  const kind = agentKind(host.platform);
  if (kind === "launchd")
    return [join(host.home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`)];
  if (kind === "systemd") {
    const xdg = host.env.XDG_CONFIG_HOME?.trim();
    const config = xdg && isAbsolute(xdg) ? xdg : join(host.home, ".config");
    const dir = join(config, "systemd", "user");
    return [join(dir, `${AGENT_UNIT}.service`), join(dir, `${AGENT_UNIT}.timer`)];
  }
  return [];
}

/** The job's PATH: the recorded node's directory first, then /usr/bin and /bin. */
export function agentPath(node: string): string {
  return [dirname(node), "/usr/bin", "/bin"].join(":");
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchdPlist(paths: RuntimePaths, node: string): string {
  const args = [paths.shim, "runtime", "update", "--auto"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(agentPath(node))}</string>
    <key>BROWX_RUNTIME_NODE</key>
    <string>${xml(node)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${AGENT_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.agentLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.agentLog)}</string>
</dict>
</plist>
`;
}

/** One systemd word in double quotes. `%` and `$` are doubled so systemd takes
 *  them literally, and `\` and `"` are escaped. */
function unitWord(text: string): string {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

export function systemdService(paths: RuntimePaths, node: string): string {
  return `[Unit]
Description=browxai runtime update check

[Service]
Type=oneshot
ExecStart=${unitWord(paths.shim)} runtime update --auto
Environment=${unitWord(`PATH=${agentPath(node)}`)}
Environment=${unitWord(`BROWX_RUNTIME_NODE=${node}`)}
Nice=10
IOSchedulingClass=idle
`;
}

export function systemdTimer(): string {
  return `[Unit]
Description=Hourly browxai runtime update check

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
`;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  );
}

async function step(host: AgentHost, file: string, args: string[]): Promise<AgentResult> {
  const r = await host.run(file, args, { timeoutMs: 30_000 });
  const cmd = `${file === LAUNCHCTL ? "launchctl" : file} ${args.join(" ")}`;
  if (r.status === 0) return { ok: true, detail: cmd };
  return {
    ok: false,
    detail: `${cmd} failed (${r.error ?? (firstLine(r.stderr) || `exit ${r.status}`)})`,
  };
}

/** The job's log, created 0600 before launchd opens it, so it never gets the umask's mode. */
function touchPrivate(path: string): void {
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
}

async function installLaunchd(
  host: AgentHost,
  paths: RuntimePaths,
  node: string,
): Promise<AgentResult> {
  if (host.uid === undefined) {
    return {
      ok: false,
      detail: "no user id, so there is no launchd user domain to load the job in",
    };
  }
  const [plist] = agentFiles(host);
  mkdirSync(dirname(plist!), { recursive: true });
  touchPrivate(paths.agentLog);
  writeFileAtomic(plist!, launchdPlist(paths, node), 0o644);
  const domain = `gui/${host.uid}`;
  // A job loaded by an earlier install keeps its old plist until it is unloaded.
  await host.run(LAUNCHCTL, ["bootout", `${domain}/${AGENT_LABEL}`], { timeoutMs: 30_000 });
  const loaded = await step(host, LAUNCHCTL, ["bootstrap", domain, plist!]);
  return loaded.ok
    ? { ok: true, detail: `launchd job ${AGENT_LABEL} loaded from ${plist}` }
    : loaded;
}

async function installSystemd(
  host: AgentHost,
  paths: RuntimePaths,
  node: string,
): Promise<AgentResult> {
  const [service, timer] = agentFiles(host);
  mkdirSync(dirname(service!), { recursive: true });
  writeFileAtomic(service!, systemdService(paths, node), 0o644);
  writeFileAtomic(timer!, systemdTimer(), 0o644);
  const reload = await step(host, "systemctl", ["--user", "daemon-reload"]);
  if (!reload.ok) return reload;
  const enabled = await step(host, "systemctl", [
    "--user",
    "enable",
    "--now",
    `${AGENT_UNIT}.timer`,
  ]);
  return enabled.ok
    ? { ok: true, detail: `systemd user timer ${AGENT_UNIT}.timer enabled` }
    : enabled;
}

async function removeJob(host: AgentHost, kind: AgentKind): Promise<AgentResult> {
  const files = agentFiles(host);
  const present = files.filter((f) => existsSync(f));
  if (present.length === 0) return { ok: true, detail: "no background job was installed" };
  // Unloading a job that isn't loaded fails; the files go either way.
  if (kind === "launchd" && host.uid !== undefined) {
    await host.run(LAUNCHCTL, ["bootout", `gui/${host.uid}/${AGENT_LABEL}`], { timeoutMs: 30_000 });
  }
  if (kind === "systemd") {
    await host.run("systemctl", ["--user", "disable", "--now", `${AGENT_UNIT}.timer`], {
      timeoutMs: 30_000,
    });
  }
  for (const f of present) rmSync(f, { force: true });
  if (kind === "systemd")
    await host.run("systemctl", ["--user", "daemon-reload"], { timeoutMs: 30_000 });
  return { ok: true, detail: `removed ${present.join(", ")}` };
}

export function systemAgent(host: AgentHost): AgentPort {
  const kind = agentKind(host.platform);
  return {
    kind,
    install: (paths, node) => {
      if (kind === "launchd") return installLaunchd(host, paths, node);
      if (kind === "systemd") return installSystemd(host, paths, node);
      return Promise.resolve({
        ok: false,
        detail: `no background job on ${host.platform}. Run browxai runtime update to update`,
      });
    },
    remove: () =>
      kind ? removeJob(host, kind) : Promise.resolve({ ok: true, detail: "no background job" }),
    installed: () => agentFiles(host).filter((f) => existsSync(f)),
  };
}
