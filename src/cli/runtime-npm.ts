// `browxai runtime`: npm, run as `<node> <npm-cli.js>` with the node the runtime
// recorded, so an update never depends on the login shell's PATH. npm reads the
// registry from the user's npm config, so a mirror in .npmrc is honoured, and its
// auth stays in npm: nothing here reads or logs an npm config value.

import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { isVersion } from "./runtime-layout.js";
import type { RunResult, Runner } from "./runtime-exec.js";

export interface NpmContext {
  node: string;
  npmCli: string;
  run: Runner;
  env: NodeJS.ProcessEnv;
}

/** Where npm's own CLI sits next to a node install: `<prefix>/lib/node_modules`
 *  for the official, nvm and mise layouts, `<prefix>/libexec/lib/node_modules`
 *  for a Homebrew keg. Checks the node path as given and its real path. */
export function findNpmCli(
  node: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const bases = [node];
  try {
    bases.push(realpathSync(node));
  } catch {
    /* the node path doesn't resolve; the caller reports it */
  }
  for (const base of bases) {
    const prefix = dirname(dirname(base));
    for (const lib of ["lib", join("libexec", "lib")]) {
      const cli = join(prefix, lib, "node_modules", "npm", "bin", "npm-cli.js");
      if (exists(cli)) return cli;
    }
  }
  return undefined;
}

/** What the registry says about one version of browxai. */
export interface VersionInfo {
  version: string;
  /** `time[version]` from the packument. */
  publishedAt?: string;
  /** The deprecation message, when the maintainers deprecated this version. */
  deprecated?: string;
  integrity?: string;
  /** `engines.node` from the version's package.json, as the registry has it. */
  enginesNode?: string;
}

export type ViewResult =
  { ok: true; info: VersionInfo } | { ok: false; unreachable: boolean; message: string };

/** The registry port: the one call an update makes before it downloads. */
export interface Registry {
  /** `spec` is a dist-tag (`latest`, `next`) or an exact version. */
  view(spec: string): Promise<ViewResult>;
}

const UNREACHABLE =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|network/i;

function npmArgs(npm: NpmContext, args: string[]): [string, string[]] {
  return [npm.node, [npm.npmCli, ...args, "--no-update-notifier"]];
}

/** The environment npm runs in: the caller's, with the recorded node's directory
 *  first on PATH, so anything npm starts finds that same node. */
export function npmEnv(npm: Pick<NpmContext, "node" | "env">): NodeJS.ProcessEnv {
  return { ...npm.env, PATH: [dirname(npm.node), npm.env.PATH].filter(Boolean).join(delimiter) };
}

export function npmRegistry(npm: NpmContext): Registry {
  return {
    async view(spec) {
      const [file, args] = npmArgs(npm, ["view", `browxai@${spec}`, "--json"]);
      const r = await npm.run(file, args, { env: npmEnv(npm), timeoutMs: 60_000 });
      return parseView(r, spec);
    },
  };
}

export function parseView(r: RunResult, spec: string): ViewResult {
  if (r.status !== 0) {
    const text = `${r.error ?? ""}\n${r.stderr}\n${r.stdout}`;
    const unreachable = r.status === null || UNREACHABLE.test(text);
    const first =
      npmErrorSummary(r.stdout) ??
      r.stderr
        .split("\n")
        .find((l) => /npm (error|ERR!)/.test(l))
        ?.trim();
    return {
      ok: false,
      unreachable,
      message: unreachable
        ? `the npm registry could not be reached (${first ?? r.error ?? `exit ${r.status}`})`
        : `npm view browxai@${spec} failed (${first ?? `exit ${r.status}`})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = r.stdout.trim() === "" ? undefined : JSON.parse(r.stdout);
  } catch {
    return {
      ok: false,
      unreachable: false,
      message: `npm view browxai@${spec} printed something that isn't JSON`,
    };
  }
  const doc = (Array.isArray(parsed) ? parsed.at(-1) : parsed) as
    Record<string, unknown> | undefined;
  const version = doc?.version;
  if (typeof version !== "string" || !isVersion(version)) {
    return {
      ok: false,
      unreachable: false,
      message: `the registry has no browxai version for "${spec}"`,
    };
  }
  const time = doc!.time as Record<string, unknown> | undefined;
  const dist = doc!.dist as Record<string, unknown> | undefined;
  const info: VersionInfo = { version };
  if (typeof time?.[version] === "string") info.publishedAt = time[version];
  if (typeof doc!.deprecated === "string" && doc!.deprecated) info.deprecated = doc!.deprecated;
  if (typeof dist?.integrity === "string") info.integrity = dist.integrity;
  const engines = doc!.engines as Record<string, unknown> | undefined;
  if (typeof engines?.node === "string" && engines.node.trim()) info.enginesNode = engines.node;
  return { ok: true, info };
}

/** With `--json`, npm prints a failure as `{"error":{"code","summary"}}` on stdout. */
function npmErrorSummary(stdout: string): string | undefined {
  try {
    const e = (JSON.parse(stdout) as { error?: { code?: unknown; summary?: unknown } }).error;
    if (typeof e?.summary === "string")
      return typeof e.code === "string" ? `${e.code}: ${e.summary}` : e.summary;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** The `--before` value for a version: its publish time plus one hour, so the
 *  transitive dependencies resolve to what existed when it was published. */
export function beforeFor(publishedAt: string): string | undefined {
  const t = Date.parse(publishedAt);
  return Number.isNaN(t) ? undefined : new Date(t + 60 * 60 * 1000).toISOString();
}

/** Install exactly `version` into `prefix`, with no lifecycle script. */
export async function npmInstall(
  npm: NpmContext,
  prefix: string,
  version: string,
  before: string,
): Promise<RunResult> {
  const [file, args] = npmArgs(npm, [
    "install",
    "--prefix",
    prefix,
    `browxai@${version}`,
    "--save-exact",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--before",
    before,
  ]);
  return npm.run(file, args, { cwd: prefix, env: npmEnv(npm), timeoutMs: 10 * 60_000 });
}

export interface Verification {
  ok: boolean;
  detail: string;
}

/** `npm audit signatures` in the staged prefix: the registry signature of every
 *  installed package and the provenance attestation where one exists. */
export async function auditSignatures(npm: NpmContext, prefix: string): Promise<Verification> {
  const [file, args] = npmArgs(npm, ["audit", "signatures", "--json", "--prefix", prefix]);
  const r = await npm.run(file, args, { cwd: prefix, env: npmEnv(npm), timeoutMs: 2 * 60_000 });
  let counts = "";
  try {
    const j = JSON.parse(r.stdout) as { invalid?: unknown[]; missing?: unknown[] };
    counts = `, ${j.invalid?.length ?? 0} invalid, ${j.missing?.length ?? 0} missing`;
  } catch {
    /* npm printed no JSON; the exit code decides */
  }
  if (r.status === 0) return { ok: true, detail: `npm audit signatures passed${counts}` };
  const why =
    r.error ??
    r.stderr
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ??
    `exit ${r.status}`;
  return { ok: false, detail: `npm audit signatures failed (${why}${counts})` };
}
