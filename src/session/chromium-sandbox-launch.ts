// Chromium's OS sandbox for the browsers browxai launches through Playwright
// (managed profile, incognito, headless shell, the installed Chrome a session opens).
// Playwright adds `--no-sandbox` to a Chromium launch unless it gets
// `chromiumSandbox: true`, so this module decides when to pass it. Three modes, from
// the `chromiumSandbox` config key / `BROWX_CHROMIUM_SANDBOX` (src/util/chromium-sandbox.ts):
//
//   off   Playwright's default. No option is passed, `--no-sandbox` is added.
//   on    Pass `chromiumSandbox: true`. A launch that fails on the sandbox throws an
//         error that says what usually causes it and how to turn the sandbox off.
//   auto  `decideSandbox` reads facts about the host. When the host cannot run the
//         sandbox the launch goes without it and a warning says why, once per
//         process. Otherwise the launch asks for the sandbox, and a failure that
//         names the sandbox is retried once without it, with a loud warning. The
//         failure is remembered for the rest of the process, so later launches skip
//         the sandbox without a second failed start. Any other failure is not retried.
//         Root and a container skip the sandbox for every browser. The kernel's
//         user-namespace and AppArmor facts skip it only for the bundled Chromium
//         and the headless shell: an installed Chrome or Edge carries its own setuid
//         helper and AppArmor profile, so it is tried and the retry covers a failure.
//
// Not applied to a Chrome browxai does not launch through Playwright: `browxai chrome
// start` / `chrome login` spawn Chrome directly and keep its sandbox, and an attached
// browser was launched by someone else. Firefox, WebKit, Android, Safari and Electron
// are not Chromium launches.
//
// The probe is a plain object so a test can replace what it reports. `decideSandbox`
// is pure.

import { existsSync, readFileSync } from "node:fs";
import { log } from "../util/logging.js";
import {
  CHROMIUM_SANDBOX_ENV,
  sandboxRelaxHint,
  type ChromiumSandboxMode,
  type ChromiumSandboxSource,
} from "../util/chromium-sandbox.js";

/** What the probe reports about the host. Linux fields are undefined elsewhere, and
 *  when the kernel file is absent or unreadable (an unknown is treated as "try it":
 *  the retry covers a host that turns out not to support the sandbox). */
export interface SandboxFacts {
  platform: NodeJS.Platform;
  /** The process uid, undefined where the platform has none (Windows). */
  uid: number | undefined;
  /** The container signal that was found (`/.dockerenv`, ...), when there is one. */
  container?: string;
  /** `/proc/sys/user/max_user_namespaces`. */
  maxUserNamespaces?: number;
  /** `/proc/sys/kernel/unprivileged_userns_clone`. */
  unprivilegedUsernsClone?: number;
  /** `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`. */
  apparmorRestrictUserns?: number;
}

export type SandboxVerdict = "supported" | "root" | "container" | "no-userns" | "apparmor";

export interface SandboxDecision {
  /** True when `auto` asks for the sandbox. */
  sandbox: boolean;
  verdict: SandboxVerdict;
  /** One clause saying why, for the warning and the doctor row. */
  reason: string;
}

/** Which browser a launch attempt targets. An installed channel (Google Chrome,
 *  Edge) ships its own setuid sandbox helper and, on a distribution that restricts
 *  user namespaces, an AppArmor profile, so it can run sandboxed where the bundled
 *  Chromium and the headless shell cannot. */
export type SandboxTarget = "installed" | "bundled";

/** The user-namespace facts that rule out the bundled build, or undefined. */
function usernsBlock(facts: SandboxFacts): SandboxDecision | undefined {
  if (facts.maxUserNamespaces === 0) {
    return {
      sandbox: false,
      verdict: "no-userns",
      reason: "the kernel allows no user namespaces (user.max_user_namespaces is 0)",
    };
  }
  if (facts.unprivilegedUsernsClone === 0) {
    return {
      sandbox: false,
      verdict: "no-userns",
      reason:
        "the kernel blocks unprivileged user namespaces (kernel.unprivileged_userns_clone is 0)",
    };
  }
  if (facts.apparmorRestrictUserns === 1) {
    return {
      sandbox: false,
      verdict: "apparmor",
      reason:
        "an AppArmor policy restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns is 1)",
    };
  }
  return undefined;
}

/** Decide whether `auto` should ask for the sandbox on a host with these facts.
 *  Root and a container skip it for every target. The user-namespace facts skip it
 *  only for the bundled build: an installed channel is tried and the one retry
 *  catches a host where it cannot start. */
export function decideSandbox(
  facts: SandboxFacts,
  target: SandboxTarget = "bundled",
): SandboxDecision {
  if (facts.uid === 0) {
    return {
      sandbox: false,
      verdict: "root",
      reason: "the process runs as root, and Chromium does not start its sandbox as root",
    };
  }
  if (facts.platform === "linux") {
    if (facts.container) {
      return {
        sandbox: false,
        verdict: "container",
        reason: `the process runs in a container (${facts.container})`,
      };
    }
    const block = target === "bundled" ? usernsBlock(facts) : undefined;
    if (block) return block;
  }
  return { sandbox: true, verdict: "supported", reason: "the host supports it" };
}

/** File access the probe needs, so a test can describe a host without having one. */
export interface SandboxIo {
  platform: NodeJS.Platform;
  uid(): number | undefined;
  exists(path: string): boolean;
  read(path: string): string | undefined;
}

const nodeIo: SandboxIo = {
  platform: process.platform,
  uid: () => (typeof process.getuid === "function" ? process.getuid() : undefined),
  exists: (path) => existsSync(path),
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

const CONTAINER_CGROUP = /(docker|kubepods|containerd|libpod|lxc)/;

function intAt(io: SandboxIo, path: string): number | undefined {
  const raw = io.read(path)?.trim();
  if (!raw || !/^-?\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function containerSignal(io: SandboxIo): string | undefined {
  if (io.exists("/.dockerenv")) return "/.dockerenv exists";
  if (io.exists("/run/.containerenv")) return "/run/.containerenv exists";
  const cgroup = io.read("/proc/1/cgroup");
  const hit = cgroup ? CONTAINER_CGROUP.exec(cgroup)?.[1] : undefined;
  return hit ? `/proc/1/cgroup names ${hit}` : undefined;
}

/** Read the facts `decideSandbox` needs. Reads nothing outside Linux except the uid. */
export function gatherSandboxFacts(io: SandboxIo = nodeIo): SandboxFacts {
  const facts: SandboxFacts = { platform: io.platform, uid: io.uid() };
  if (io.platform !== "linux") return facts;
  const container = containerSignal(io);
  if (container) facts.container = container;
  facts.maxUserNamespaces = intAt(io, "/proc/sys/user/max_user_namespaces");
  facts.unprivilegedUsernsClone = intAt(io, "/proc/sys/kernel/unprivileged_userns_clone");
  facts.apparmorRestrictUserns = intAt(
    io,
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
  );
  return facts;
}

/** The probe `auto` reads. Replace `gather` in a test to describe another host. */
export const sandboxProbe = { gather: (): SandboxFacts => gatherSandboxFacts() };

/** Text Chromium prints when its sandbox cannot start, plus the line Playwright
 *  replaces it with ("Chromium sandboxing failed!", keyed on the two crbug ids). */
const SANDBOX_FAILURE_MARKERS = [
  "Chromium sandboxing failed",
  "No usable sandbox",
  "Running as root without --no-sandbox",
  "sandbox_host_linux",
  "Failed to move to new namespace",
  "setuid sandbox",
  "crbug.com/357670",
  "crbug.com/638180",
] as const;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when a failed launch names the sandbox as the reason. */
export function isSandboxFailure(err: unknown): boolean {
  const message = messageOf(err).toLowerCase();
  return SANDBOX_FAILURE_MARKERS.some((marker) => message.includes(marker.toLowerCase()));
}

/** The line of the error that names the sandbox, trimmed for a log line. */
function excerptOf(err: unknown): string {
  const lines = messageOf(err)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = lines.find((l) => isSandboxFailure(new Error(l))) ?? lines[0] ?? "no message";
  return hit.length > 200 ? `${hit.slice(0, 197)}...` : hit;
}

const warned = new Set<string>();

/** Targets whose sandbox launch failed in this process. A host that hides its
 *  container (cgroup v2 with no marker file) shows up here after one failed start, and
 *  later launches skip the sandbox without a second failed browser start. */
const failedTargets = new Set<SandboxTarget>();

/** Forget the one-time warnings and the remembered failures. For tests. */
export function resetSandboxState(): void {
  warned.clear();
  failedTargets.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message);
}

const ON_FAILURE_CAUSES =
  "the process runs as root, the container has no user namespaces, " +
  "or an AppArmor policy restricts unprivileged user namespaces";

/** The option a launch merges into its Playwright launch options. */
export type SandboxLaunchOption = { chromiumSandbox?: true };

type SandboxLaunch<T> = (sandboxOption: SandboxLaunchOption) => Promise<T>;

async function launchWithoutSandbox<T>(launch: SandboxLaunch<T>, reason: string): Promise<T> {
  const result = await launch({});
  log.info("session: Chromium OS sandbox off", { reason });
  return result;
}

async function launchWithSandbox<T>(
  launch: SandboxLaunch<T>,
  mode: ChromiumSandboxMode,
): Promise<T> {
  const result = await launch({ chromiumSandbox: true });
  log.info("session: Chromium OS sandbox on", { mode });
  return result;
}

/** What `launchWithSandboxPlan` knows about the attempt. */
export interface SandboxPlanContext {
  /** Which browser this attempt launches. Defaults to the bundled build. */
  target?: SandboxTarget;
  /** Which config layer the mode came from, for the fix an `on` failure names. */
  source?: ChromiumSandboxSource;
}

/** `on`: the launch asks for the sandbox and does not fall back. */
async function launchRequiringSandbox<T>(
  launch: SandboxLaunch<T>,
  source: ChromiumSandboxSource | undefined,
): Promise<T> {
  try {
    return await launchWithSandbox(launch, "on");
  } catch (err) {
    if (!isSandboxFailure(err)) throw err;
    throw new Error(
      "browxai: Chromium's OS sandbox failed to start and chromiumSandbox is on, so browxai " +
        `did not fall back to launching without it. Usual causes: ${ON_FAILURE_CAUSES}. ` +
        `${sandboxRelaxHint(source)}\n\nChromium said: ${excerptOf(err)}`,
      { cause: err },
    );
  }
}

const TARGET_LABEL: Record<SandboxTarget, string> = {
  installed: "the installed Google Chrome",
  bundled: "the bundled Chromium and the headless shell",
};

/** `auto`: skip the sandbox on a host that cannot run it, or where a launch already
 *  failed on it in this process. Otherwise try it once and fall back once. A failure
 *  that does not name the sandbox is never retried. */
async function launchTryingSandbox<T>(launch: SandboxLaunch<T>, target: SandboxTarget): Promise<T> {
  const decision = decideSandbox(sandboxProbe.gather(), target);
  if (!decision.sandbox) {
    // Root and a container skip every browser. The kernel facts skip the bundled build only.
    const appliesTo =
      decision.verdict === "root" || decision.verdict === "container"
        ? "every browser browxai launches"
        : TARGET_LABEL[target];
    warnOnce(
      `auto-off:${decision.verdict}`,
      `session: Chromium's OS sandbox is off for ${appliesTo}, because ${decision.reason}. ` +
        "Page content runs without that boundary, so the container or VM is the containment. " +
        `To try the sandbox anyway, set ${CHROMIUM_SANDBOX_ENV}=on. ` +
        `To keep it off and drop this warning, set ${CHROMIUM_SANDBOX_ENV}=off.`,
    );
    return launchWithoutSandbox(launch, decision.reason);
  }
  if (failedTargets.has(target)) {
    return launchWithoutSandbox(launch, "an earlier launch in this process failed on the sandbox");
  }
  try {
    return await launchWithSandbox(launch, "auto");
  } catch (err) {
    if (!isSandboxFailure(err)) throw err;
    failedTargets.add(target);
    warnOnce(
      `sandbox-failed:${target}`,
      `session: Chromium's OS sandbox failed to start for ${TARGET_LABEL[target]} (${excerptOf(err)}), ` +
        `so browxai is launching it without the sandbox, and will launch later ${TARGET_LABEL[target]} in this process the same way. ` +
        "Page content now runs without Chromium's OS sandbox. " +
        "A failure that was only transient is remembered too: restart the server or set " +
        `${CHROMIUM_SANDBOX_ENV}=on to retry the sandbox. ` +
        `Otherwise fix the host (user namespaces, an AppArmor policy, running as a non-root user) or set ${CHROMIUM_SANDBOX_ENV}=off ` +
        "to skip the attempt and this warning.",
    );
    return launchWithoutSandbox(launch, "the sandbox failed to start");
  }
}

/** Run `launch` under the sandbox mode. `launch` gets the option to merge into the
 *  Playwright launch options and must make the whole launch attempt from it. */
export function launchWithSandboxPlan<T>(
  mode: ChromiumSandboxMode,
  launch: SandboxLaunch<T>,
  context: SandboxPlanContext = {},
): Promise<T> {
  if (mode === "off") return launchWithoutSandbox(launch, "chromiumSandbox is off");
  if (mode === "on") return launchRequiringSandbox(launch, context.source);
  return launchTryingSandbox(launch, context.target ?? "bundled");
}
