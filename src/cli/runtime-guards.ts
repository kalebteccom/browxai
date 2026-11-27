// `browxai runtime`: the reasons a newer version is held instead of applied (RFC
// 0015, sections 4 and 5). Each guard names what it found and the command that
// releases the version:
//   - D7, the version guard: a new major version from 1.0 on waits for
//     `update --allow-major` or `runtime config major allow`;
//   - the Node engines hold: a version whose `engines.node` the runtime's node
//     doesn't satisfy;
//   - D20, the Playwright bump: a version that moves playwright-core on a machine
//     with no Google Chrome needs a Chromium download, which the updater never
//     does. It is held until the owner applies it by hand.
// A version a rollback left is held too, until a newer one appears or the owner
// names it with `runtime update --version`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NpmContext, VersionInfo } from "./runtime-npm.js";
import { satisfiesRange } from "./runtime-range.js";

/** The hold a rollback leaves on the version it switched away from. */
export const ROLLED_BACK = "rolled back by user";

/** The major part of a version, or undefined when it isn't one. */
function majorOf(version: string): number | undefined {
  const m = /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : undefined;
}

/**
 * D7: the reason `candidate` is held because it starts a new major version, or
 * undefined. Before 1.0 a minor crosses on its own, so only a candidate at 1.0.0
 * or later with a higher major than `current` is held, 1.0.0 over a 0.x included.
 */
export function majorHold(
  candidate: string,
  current: string | undefined,
  allowMajor: boolean,
): string | undefined {
  if (!current || allowMajor) return undefined;
  const to = majorOf(candidate);
  const from = majorOf(current);
  if (to === undefined || from === undefined || to < 1 || to <= from) return undefined;
  return (
    `a new major version (${current} to ${candidate}). Run browxai runtime update --allow-major, ` +
    "or browxai runtime config major allow"
  );
}

/** The Node engines hold: the reason, or undefined when the node satisfies the
 *  range or either can't be read. */
export function enginesHold(
  range: string | undefined,
  nodeVersion: string | undefined,
  nodePath: string,
): string | undefined {
  if (!range || !nodeVersion) return undefined;
  if (satisfiesRange(nodeVersion, range) !== false) return undefined;
  return `needs Node ${range}, and the runtime's node at ${nodePath} is ${nodeVersion.replace(/^v/, "")}`;
}

/** The Node engines hold for one version. */
export type EnginesCheck = (info: VersionInfo) => Promise<string | undefined>;

/** The engines hold against the runtime's node. The node's version is read only
 *  for a version whose package names `engines.node`. */
export function enginesCheck(npm: Pick<NpmContext, "node" | "run">): EnginesCheck {
  let version: Promise<string | undefined> | undefined;
  return async (info) => {
    if (!info.enginesNode) return undefined;
    version ??= nodeVersionOf(npm);
    return enginesHold(info.enginesNode, await version, npm.node);
  };
}

/** The first guard that holds `info.version`: the major guard, then Node engines. */
export async function guardReason(
  info: VersionInfo,
  current: string | undefined,
  allowMajor: boolean,
  engines: EnginesCheck,
): Promise<string | undefined> {
  return majorHold(info.version, current, allowMajor) ?? (await engines(info));
}

/** The version of `npm.node`: this process's own when it is the same file,
 *  else what `<node> --version` prints. Undefined when it can't be read. */
export async function nodeVersionOf(
  npm: Pick<NpmContext, "node" | "run">,
): Promise<string | undefined> {
  if (npm.node === process.execPath) return process.versions.node;
  const r = await npm.run(npm.node, ["--version"], { timeoutMs: 10_000 });
  const m = /^v?(\d+\.\d+\.\d+)\s*$/.exec(r.stdout.trim());
  return r.status === 0 && m ? m[1] : undefined;
}

/** The version of `name` installed under the npm prefix `prefix`, or undefined. */
export function installedPackageVersion(prefix: string, name: string): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(prefix, "node_modules", name, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** A row of `doctor --json`. */
export interface DoctorRow {
  name: string;
  ok: boolean;
  info?: boolean;
}

/** Whether a `doctor --json` report says sessions here fall back to the bundled
 *  Chromium: the `chrome` row fails (no Google Chrome), or the `chromium` row is
 *  a requirement (channel "chromium" is set). */
export function usesBundledChromium(rows: readonly DoctorRow[]): boolean {
  // Rows by name: doctor's row names, not an engine choice.
  const byName = new Map(rows.map((r) => [r.name, r]));
  const chrome = byName.get("chrome");
  const chromium = byName.get("chromium");
  return (!!chrome && !chrome.ok) || (!!chromium && chromium.ok && chromium.info !== true);
}

/** D20: the reason a staged version is held for its Playwright bump, or undefined. */
export function playwrightHold(
  version: string,
  from: string | undefined,
  to: string | undefined,
  bundledChromium: boolean,
): string | undefined {
  if (!from || !to || from === to || !bundledChromium) return undefined;
  return (
    `needs a Chromium download: it moves playwright-core from ${from} to ${to}, and this machine has no Google Chrome. ` +
    `Run browxai runtime update --version ${version}, then npx playwright-core@${to} install chromium`
  );
}
