// Temp runtime directories for the `browxai runtime` tests. Test code only.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cliOf,
  runtimePaths,
  versionDir,
  type RuntimeContext,
  type RuntimePaths,
} from "../runtime-layout.js";
import { createLayout } from "../runtime-store.js";
import type { RunResult, Runner } from "../runtime-exec.js";
import type { Registry } from "../runtime-npm.js";
import type { AgentKind, AgentPort } from "../runtime-agent.js";

export interface TempRuntime {
  /** A fresh temp directory that stands in for the home directory. */
  home: string;
  paths: RuntimePaths;
  ctx: RuntimeContext;
  cleanup: () => void;
}

/** The uid the tests run as. CI containers run as root, which every runtime
 *  command refuses, so there the owner checks are left out (undefined, as on
 *  Windows). The root refusal has its own test. */
export function testUid(): number | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === 0 ? undefined : uid;
}

/** A home directory with a runtime path under it. `create` lays the runtime out. */
export function tempRuntime(opts: { create?: boolean; dirName?: string } = {}): TempRuntime {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "bx-rt-")));
  const paths = runtimePaths(join(home, opts.dirName ?? ".browxai-runtime"));
  if (opts.create !== false) createLayout(paths);
  const ctx: RuntimeContext = {
    env: { BROWX_WORKSPACE: join(home, "workspace"), BROWX_RUNTIME_DIR: paths.root },
    home,
    platform: process.platform,
    uid: testUid(),
  };
  return { home, paths, ctx, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A kept version whose `cli.js` is `body` (by default one that prints its version). */
export function addVersion(paths: RuntimePaths, version: string, body?: string): string {
  const cli = cliOf(versionDir(paths, version));
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, body ?? `process.stdout.write(${JSON.stringify(version)} + "\\n");\n`);
  chmodSync(versionDir(paths, version), 0o700);
  return cli;
}

/** A fake `Runner` for npm: `install` lays out `node_modules/browxai` at the
 *  requested version (or at `installs` as given, to fake a lying registry),
 *  `audit signatures` answers `audit`. Every call is recorded. */
export function fakeNpm(
  opts: { audit?: number; installStatus?: number; installs?: string; cliBody?: string } = {},
): Runner & { calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner = (file: string, args: readonly string[]): Promise<RunResult> => {
    calls.push({ file, args: [...args] });
    if (args.includes("install")) {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const spec = args.find((a) => a.startsWith("browxai@"))!;
      if (opts.installStatus) {
        return Promise.resolve({
          status: opts.installStatus,
          stdout: "",
          stderr: "npm error code E500\n",
        });
      }
      const version = opts.installs ?? spec.slice("browxai@".length);
      // `prefix` is a staging directory of a runtime that tempRuntime() made under tmpdir().
      const pkgDir = join(prefix, "node_modules", "browxai");
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "browxai", version }));
      writeFileSync(join(pkgDir, "dist", "cli.js"), opts.cliBody ?? "");
      return Promise.resolve({ status: 0, stdout: "", stderr: "" });
    }
    if (args.includes("audit")) {
      const status = opts.audit ?? 0;
      return Promise.resolve({
        status,
        stdout: JSON.stringify({ invalid: status ? [{}] : [], missing: [] }),
        stderr: "",
      });
    }
    return Promise.resolve({ status: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` });
  };
  return Object.assign(runner, { calls });
}

/** A registry port that answers from a table of versions and dist-tags. */
export function fakeRegistry(
  versions: Record<string, { publishedAt?: string; deprecated?: string }>,
  tags: Record<string, string>,
  opts: { unreachable?: boolean } = {},
): Registry {
  return {
    view(spec) {
      if (opts.unreachable) {
        return Promise.resolve({
          ok: false,
          unreachable: true,
          message: "the npm registry could not be reached (ENOTFOUND)",
        });
      }
      const version = tags[spec] ?? spec;
      const v = versions[version];
      if (!v)
        return Promise.resolve({
          ok: false,
          unreachable: false,
          message: `no browxai version for "${spec}"`,
        });
      return Promise.resolve({
        ok: true,
        info: {
          version,
          publishedAt: v.publishedAt ?? "2026-11-20T10:00:00.000Z",
          ...(v.deprecated ? { deprecated: v.deprecated } : {}),
        },
      });
    },
  };
}

/** A background job that records what it was asked to do and touches no launchd
 *  or systemd. `installed()` reports a job once `install` ran and until `remove`. */
export function fakeAgent(
  opts: { kind?: AgentKind | undefined; installOk?: boolean } = {},
): AgentPort & { calls: string[] } {
  const calls: string[] = [];
  let present = false;
  const kind = "kind" in opts ? opts.kind : "systemd";
  return {
    kind,
    calls,
    install: (paths, node) => {
      calls.push(`install ${paths.shim} ${node}`);
      present = opts.installOk !== false;
      return Promise.resolve(
        present
          ? { ok: true, detail: "fake job loaded" }
          : { ok: false, detail: "systemctl --user daemon-reload failed (no user bus)" },
      );
    },
    remove: () => {
      calls.push("remove");
      present = false;
      return Promise.resolve({ ok: true, detail: "removed the fake job" });
    },
    installed: () => (present ? ["/fake/browxai-runtime-update.timer"] : []),
  };
}
