// `browxai runtime install` and `update`: pick a version, then stage, verify,
// smoke-check and switch to it (RFC 0015, section 4). A version that fails any
// step never becomes `current`: its staging directory is removed, the failure is
// recorded in state.json, and `current` stays as it was. A held version (see
// runtime-guards.ts) is applied only when `--version` names it.

import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  guardReason,
  installedPackageVersion,
  majorHold,
  playwrightHold,
  type EnginesCheck,
} from "./runtime-guards.js";
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
import { viewChannel } from "./runtime-channel.js";
import { pinProvenance } from "./runtime-provenance.js";
import { heldReason } from "./runtime-schedule.js";
import type { Channel } from "./runtime-settings.js";
import { smokeCheck, type SmokeResult } from "./runtime-smoke.js";
import {
  ensurePrivateDir,
  readCurrent,
  readState,
  switchCurrent,
  updateState,
  writeFileAtomic,
  writeState,
  type RuntimeState,
} from "./runtime-store.js";

export type Selection =
  | { kind: "apply"; info: VersionInfo; current?: string; warnings: string[] }
  | { kind: "none"; message: string }
  /** The channel's version is newer and held; `reason` says why and what releases it. */
  | { kind: "held"; info: VersionInfo; reason: string; message: string }
  /** `code` 3: the registry could not be reached. 1: anything else. */
  | { kind: "error"; code: 1 | 3; message: string };

/** The guards a selection applies. With none, nothing is held by a guard. */
export interface SelectGuards {
  /** `--allow-major` or `runtime config major allow`. */
  allowMajor: boolean;
  engines: EnginesCheck;
}

const NO_GUARDS: SelectGuards = { allowMajor: true, engines: () => Promise.resolve(undefined) };

/**
 * The version to apply: the channel's dist-tag, or `--version V`. The tag's
 * version is skipped when it isn't newer than `current`, or when the
 * maintainers deprecated it, and held when state.json holds it, it failed three
 * times, or a guard holds it. A named version is applied up or down, with a
 * warning for a downgrade, a deprecation, a new major version or a Node engines
 * range this node misses.
 */
export async function selectVersion(
  paths: RuntimePaths,
  registry: Registry,
  want: { channel: Channel; version?: string },
  guards: SelectGuards = NO_GUARDS,
): Promise<Selection> {
  const viewed =
    want.version === undefined
      ? await viewChannel(registry, want.channel)
      : await registry.view(want.version);
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
    const guard = await guardReason(info, current, guards.allowMajor, guards.engines);
    const held = heldReason(info.version, readState(paths), guard);
    if (held) return heldSelection(info, held, current);
  } else {
    if (current && compareVersions(info.version, current) < 0) {
      warnings.push(`${info.version} is older than current ${current}`);
    }
    if (info.deprecated)
      warnings.push(`${info.version} is deprecated on the registry ("${info.deprecated}")`);
    if (majorHold(info.version, current, false))
      warnings.push(`${info.version} is a new major version over ${current}`);
    const engines = await guards.engines(info);
    if (engines) warnings.push(`${info.version} ${engines}`);
  }
  return { kind: "apply", info, ...(current ? { current } : {}), warnings };
}

function heldSelection(info: VersionInfo, reason: string, current?: string): Selection {
  const v = info.version;
  // A reason that names its own command needs no second one.
  const release = /\bRun browxai runtime\b/.test(reason)
    ? ""
    : ` To apply it anyway: browxai runtime update --version ${v}.`;
  return {
    kind: "held",
    info,
    reason,
    message: `${v} is held: ${reason}. current stays ${current ?? "unset"}.${release}`,
  };
}

export interface ApplyDeps {
  registry: Registry;
  npm: NpmContext;
  /** Checks the staged prefix. `npm audit signatures` unless a test passes its own. */
  verify?: (npm: NpmContext, prefix: string) => Promise<Verification>;
  smoke?: typeof smokeCheck;
  /** `--version V` named this version: a Playwright bump is applied, with a note,
   *  instead of held (D20). */
  named?: boolean;
  out: (line: string) => void;
  now?: () => Date;
  pid?: number;
}

/** `held` is set when the version was held instead of failing a check. */
export type ApplyResult =
  { ok: true; version: string; previous?: string } | { ok: false; reason: string; held?: string };

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
  writeState(paths, {
    ...state,
    failed,
    held: heldAfterApply(state, v),
    ...(previous ? { previous } : {}),
  });
  return { ok: true, version: v, ...(before && before !== v ? { previous: before } : {}) };
}

/** Applying `v` releases its own hold and the holds of older versions: a hold
 *  clears once a newer version is in place. */
function heldAfterApply(state: RuntimeState, v: string): Record<string, string> {
  const held: Record<string, string> = {};
  for (const [k, reason] of Object.entries(state.held ?? {})) {
    let older: boolean;
    try {
      older = compareVersions(k, v) <= 0;
    } catch {
      older = false;
    }
    if (!older) held[k] = reason;
  }
  return held;
}

type Staged = { ok: true; prefix: string } | { ok: false; reason: string; held?: string };

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
  const found = installedPackageVersion(prefix, "browxai");
  if (found !== v || !existsSync(cliOf(prefix)))
    return fail(`the staged tree holds ${found ?? "no browxai"}, expected ${v} with dist/cli.js`);
  const verified = await (deps.verify ?? auditSignatures)(deps.npm, prefix);
  deps.out(`  ${verified.ok ? "✓" : "✗"} ${verified.detail}\n`);
  if (!verified.ok) return fail(`verification failed: ${verified.detail}`, "verification failed");
  const provenance = await pinProvenance(info, deps.registry);
  deps.out(`  ${provenance.ok ? "✓" : "✗"} ${provenance.detail}\n`);
  if (!provenance.ok) {
    // A mismatch holds the version for good. An attestation that couldn't be
    // read is an ordinary failure, retried at the next check.
    return provenance.transient
      ? fail(`the provenance check couldn't run: ${provenance.detail}`)
      : fail(`verification failed: ${provenance.detail}`, "verification failed");
  }
  const current = readCurrent(paths);
  const smoke: SmokeResult = await (deps.smoke ?? smokeCheck)(
    { cli: cliOf(prefix), version: v },
    current ? cliOf(versionDir(paths, current)) : undefined,
    { node: deps.npm.node, run: deps.npm.run, env: deps.npm.env },
  );
  if (!smoke.ok) return fail(`smoke check failed: ${smoke.reason}`);
  for (const note of smoke.notes) deps.out(`  note: ${note}\n`);
  deps.out(`  ✓ smoke check: --version, MCP handshake, doctor\n`);
  const bump = playwrightBump(paths, current, prefix, v, smoke.bundledChromium === true);
  if (bump && !deps.named) {
    rmSync(prefix, { recursive: true, force: true });
    updateState(paths, (s) => ({ ...s, held: { ...s.held, [v]: bump.hold } }));
    return { ok: false, reason: `held: ${bump.hold}`, held: bump.hold };
  }
  if (bump) {
    deps.out(
      `  note: ${v} moves playwright-core from ${bump.from} to ${bump.to}, and this machine has no Google Chrome. ` +
        `Run: npx playwright-core@${bump.to} install chromium\n`,
    );
  }
  writeMeta(prefix, info, deps, `${verified.detail}; ${provenance.detail}`);
  return { ok: true, prefix };
}

/** D20: the staged version moves playwright-core away from `current`'s on a
 *  machine whose sessions launch the bundled Chromium. */
function playwrightBump(
  paths: RuntimePaths,
  current: string | undefined,
  prefix: string,
  v: string,
  bundledChromium: boolean,
): { hold: string; from: string; to: string } | undefined {
  if (!current) return undefined;
  const from = installedPackageVersion(versionDir(paths, current), "playwright-core");
  const to = installedPackageVersion(prefix, "playwright-core");
  const hold = playwrightHold(v, from, to, bundledChromium);
  return hold ? { hold, from: from!, to: to! } : undefined;
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

/** npm's first error line, leaving out the pointer to its debug log. */
function npmFailure(stderr: string): string | undefined {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^npm (error|ERR!)/.test(l) && !/complete log/i.test(l));
}
