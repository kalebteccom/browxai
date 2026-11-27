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
