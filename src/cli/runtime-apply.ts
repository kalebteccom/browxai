// `browxai runtime install` and `update`: pick a version, then stage, verify,
// smoke-check and switch to it (RFC 0015, section 4). A version that fails any
// step never becomes `current`: its staging directory is removed, the failure is
// recorded in state.json, and `current` stays as it was.

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cliOf, compareVersions, versionDir, type RuntimePaths } from "./runtime-layout.js";
import {
  auditSignatures,
  beforeFor,
  npmInstall,
  type NpmContext,
  type Registry,
  type Verification,
  type VersionInfo,
} from "./runtime-npm.js";
import { smokeCheck, type SmokeResult } from "./runtime-smoke.js";
import {
  ensurePrivateDir,
  readCurrent,
  readState,
  switchCurrent,
  writeFileAtomic,
  writeState,
} from "./runtime-store.js";

export type Selection =
  | { kind: "apply"; info: VersionInfo; current?: string; warnings: string[] }
  | { kind: "none"; message: string }
  /** `code` 3: the registry could not be reached. 1: anything else. */
  | { kind: "error"; code: 1 | 3; message: string };

/**
 * The version to apply: the channel's dist-tag, or `--version V`. The tag's
 * version is skipped when it isn't newer than `current`, or when the
 * maintainers deprecated it. A named version is applied up or down, with a
 * warning for a downgrade or a deprecation.
 */
export async function selectVersion(
  paths: RuntimePaths,
  registry: Registry,
  want: { channel: string; version?: string },
): Promise<Selection> {
  const viewed = await registry.view(want.version ?? want.channel);
  if (!viewed.ok)
    return { kind: "error", code: viewed.unreachable ? 3 : 1, message: viewed.message };
  const { info } = viewed;
  const current = readCurrent(paths);
  const warnings: string[] = [];
  if (want.version === undefined) {
    if (current && compareVersions(info.version, current) <= 0) {
      return {
        kind: "none",
        message: `current is ${current}, and the ${want.channel} channel has ${info.version}. Nothing to do.`,
      };
    }
    if (info.deprecated) {
      return {
        kind: "none",
        message: `${info.version} is deprecated on the registry ("${info.deprecated}"), so it is skipped.`,
      };
    }
  } else {
    if (current && compareVersions(info.version, current) < 0) {
      warnings.push(`${info.version} is older than current ${current}`);
    }
    if (info.deprecated)
      warnings.push(`${info.version} is deprecated on the registry ("${info.deprecated}")`);
  }
  return { kind: "apply", info, ...(current ? { current } : {}), warnings };
}

export interface ApplyDeps {
  registry: Registry;
  npm: NpmContext;
  /** Checks the staged prefix. `npm audit signatures` unless a test passes its own. */
  verify?: (npm: NpmContext, prefix: string) => Promise<Verification>;
  smoke?: typeof smokeCheck;
  out: (line: string) => void;
  now?: () => Date;
  pid?: number;
}

export type ApplyResult =
  { ok: true; version: string; previous?: string } | { ok: false; reason: string };

/** Stage, verify, smoke-check and switch to `info.version`. A version already
 *  kept in `versions/` passed these once and is switched to directly. */
export async function applyVersion(
  paths: RuntimePaths,
  info: VersionInfo,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const v = info.version;
  const kept = versionDir(paths, v);
  if (existsSync(kept)) {
    if (!existsSync(cliOf(kept)))
      return {
        ok: false,
        reason: `${kept} exists but has no cli.js. Run browxai runtime gc, or remove it.`,
      };
    deps.out(`  ${v} is already kept in versions/, switching to it\n`);
    return switchTo(paths, v);
  }
  const staged = await stage(paths, info, deps);
  if (!staged.ok) return staged;
  try {
    renameSync(staged.prefix, kept);
  } catch (e) {
    rmSync(staged.prefix, { recursive: true, force: true });
    return {
      ok: false,
      reason: `could not move ${v} into versions/ (${(e as NodeJS.ErrnoException).code ?? "rename failed"})`,
    };
  }
  return switchTo(paths, v);
}

function switchTo(paths: RuntimePaths, v: string): ApplyResult {
  const before = readCurrent(paths);
  switchCurrent(paths, v);
  const state = readState(paths);
  const failed = { ...state.failed };
  delete failed[v];
  const previous = before && before !== v ? before : state.previous;
  writeState(paths, { ...state, failed, ...(previous ? { previous } : {}) });
  return { ok: true, version: v, ...(before && before !== v ? { previous: before } : {}) };
}

type Staged = { ok: true; prefix: string } | { ok: false; reason: string };

async function stage(paths: RuntimePaths, info: VersionInfo, deps: ApplyDeps): Promise<Staged> {
  const v = info.version;
  const before = info.publishedAt ? beforeFor(info.publishedAt) : undefined;
  if (!before)
    return {
      ok: false,
      reason: `the registry gives no publish time for ${v}, so it can't be installed with --before`,
    };
  const prefix = join(paths.staging, `${v}-${deps.pid ?? process.pid}`);
  rmSync(prefix, { recursive: true, force: true });
  ensurePrivateDir(prefix);
  const fail = (reason: string, held?: string): Staged => {
    rmSync(prefix, { recursive: true, force: true });
    recordFailure(paths, v, held);
    return { ok: false, reason };
  };
  writeFileAtomic(join(prefix, "package.json"), JSON.stringify({ private: true }) + "\n");
  deps.out(`  installing browxai@${v} into staging (npm, --ignore-scripts, --before ${before})\n`);
  const installed = await npmInstall(deps.npm, prefix, v, before);
  if (installed.status !== 0) {
    return fail(
      `npm install failed: ${npmFailure(installed.stderr) ?? installed.error ?? `exit ${installed.status}`}`,
    );
  }
  const found = installedVersion(prefix);
  if (found !== v || !existsSync(cliOf(prefix)))
    return fail(`the staged tree holds ${found ?? "no browxai"}, expected ${v} with dist/cli.js`);
  const verified = await (deps.verify ?? auditSignatures)(deps.npm, prefix);
  deps.out(`  ${verified.ok ? "✓" : "✗"} ${verified.detail}\n`);
  if (!verified.ok) return fail(`verification failed: ${verified.detail}`, "verification failed");
  const current = readCurrent(paths);
  const smoke: SmokeResult = await (deps.smoke ?? smokeCheck)(
    { cli: cliOf(prefix), version: v },
    current ? cliOf(versionDir(paths, current)) : undefined,
    { node: deps.npm.node, run: deps.npm.run, env: deps.npm.env },
  );
  if (!smoke.ok) return fail(`smoke check failed: ${smoke.reason}`);
  for (const note of smoke.notes) deps.out(`  note: ${note}\n`);
  deps.out(`  ✓ smoke check: --version, MCP handshake, doctor\n`);
  writeMeta(prefix, info, deps, verified.detail);
  return { ok: true, prefix };
}

function writeMeta(prefix: string, info: VersionInfo, deps: ApplyDeps, verification: string): void {
  const meta = {
    version: info.version,
    integrity: info.integrity ?? null,
    publishedAt: info.publishedAt ?? null,
    installedAt: (deps.now?.() ?? new Date()).toISOString(),
    node: deps.npm.node,
    checks: ["version", "mcp-handshake", "doctor"],
    verification,
  };
  writeFileAtomic(join(prefix, ".runtime-meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

function recordFailure(paths: RuntimePaths, v: string, held?: string): void {
  const state = readState(paths);
  const failed = { ...state.failed, [v]: (state.failed?.[v] ?? 0) + 1 };
  writeState(paths, { ...state, failed, ...(held ? { held: { ...state.held, [v]: held } } : {}) });
}

function installedVersion(prefix: string): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(prefix, "node_modules", "browxai", "package.json"), "utf8"),
    ) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** npm's first error line, leaving out the pointer to its debug log. */
function npmFailure(stderr: string): string | undefined {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^npm (error|ERR!)/.test(l) && !/complete log/i.test(l));
}
