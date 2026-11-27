// `browxai runtime`: where the runtime directory is, what lives in it, and the
// checks every runtime command runs before it reads or writes anything there. See
// docs/rfcs/0015-runtime-updates.md, section 1.
//
// A runtime directory holds one npm prefix per version under `versions/<v>`, a
// relative `current` symlink naming one of them, and the launcher at `bin/browxai`.
// This code manages a directory only when `layout.json` is in it.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** The layout this code reads and writes. A directory with another number was
 *  written by a different browxai, and every write command refuses it. */
export const LAYOUT_SCHEMA_VERSION = 1;

/** The runtime directory when neither `--dir` nor `BROWX_RUNTIME_DIR` names one. */
export const DEFAULT_RUNTIME_DIRNAME = ".browxai-runtime";

/** What a runtime command needs to know about the machine. Tests pass their own. */
export interface RuntimeContext {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** The user id this process runs as, undefined where the OS has none (Windows). */
  uid: number | undefined;
}

export function realContext(): RuntimeContext {
  return {
    env: process.env,
    home: homedir(),
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  };
}

export interface RuntimePaths {
  root: string;
  layout: string;
  settings: string;
  nodePath: string;
  bin: string;
  shim: string;
  current: string;
  versions: string;
  staging: string;
  state: string;
  journal: string;
  lock: string;
  /** Where the background job's standard output and error go. */
  agentLog: string;
}

export function runtimePaths(root: string): RuntimePaths {
  return {
    root,
    layout: join(root, "layout.json"),
    settings: join(root, "runtime.json"),
    nodePath: join(root, "node-path"),
    bin: join(root, "bin"),
    shim: join(root, "bin", "browxai"),
    current: join(root, "current"),
    versions: join(root, "versions"),
    staging: join(root, "staging"),
    state: join(root, "state.json"),
    journal: join(root, "journal.jsonl"),
    lock: join(root, "lock"),
    agentLog: join(root, "agent.log"),
  };
}

/** The npm prefix of one kept version. */
export function versionDir(paths: RuntimePaths, version: string): string {
  return join(paths.versions, version);
}

/** The `cli.js` inside an npm prefix that holds browxai. */
export function cliOf(prefix: string): string {
  return join(prefix, "node_modules", "browxai", "dist", "cli.js");
}

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** An exact semver version with no build metadata. Anything else never becomes a
 *  directory name, so a version string can't climb out of `versions/`. */
export function isVersion(value: string): boolean {
  return VERSION_RE.test(value);
}

/** Semver precedence: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return comparePrerelease(pa[4], pb[4]);
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const xs = a.split(".");
  const ys = b.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function expandHome(value: string, home: string): string {
  return value.replace(/^~(?=$|\/)/, home);
}

/**
 * The runtime directory: `--dir` when given, else `BROWX_RUNTIME_DIR`, else
 * `~/.browxai-runtime`. The variable must be absolute: the launcher sets it to an
 * absolute path, and a relative one would name a different directory in every
 * working directory.
 */
export function resolveRuntimeDir(
  ctx: RuntimeContext,
  dirFlag?: string,
): { dir: string } | { error: string } {
  if (dirFlag !== undefined) return { dir: resolve(expandHome(dirFlag, ctx.home)) };
  const fromEnv = ctx.env.BROWX_RUNTIME_DIR?.trim();
  if (fromEnv) {
    const expanded = expandHome(fromEnv, ctx.home);
    if (!isAbsolute(expanded)) {
      return { error: `BROWX_RUNTIME_DIR must be an absolute path, got "${fromEnv}"` };
    }
    return { dir: resolve(expanded) };
  }
  return { dir: join(ctx.home, DEFAULT_RUNTIME_DIRNAME) };
}

/** The steps a hand-made runtime directory gets. Nothing runs them for the user:
 *  they touch jobs and files browxai didn't create. */
export function migrationSteps(dir: string): string {
  return (
    `${dir} exists but has no layout.json, so browxai runtime did not create it. Nothing was changed.\n` +
    "To move to a managed runtime:\n" +
    "  1. Unload and remove any background job that updates that directory.\n" +
    "  2. Move the directory aside, then run: browxai runtime install\n" +
    `  3. Point client entries at ${join(dir, "bin", "browxai")}: browxai runtime install --write-client-config,\n` +
    "     with --profile-dir DIR for each further config directory.\n" +
    "  4. Remove the old directory once no process uses it.\n"
  );
}

/** What a runtime directory turned out to be, once every refusal passed. */
export type RuntimeInspection =
  | { kind: "absent" }
  | { kind: "empty" }
  | { kind: "managed"; schemaVersion: number; known: boolean };

export type Checked = { ok: true; found: RuntimeInspection } | { ok: false; reason: string };

const refuse = (reason: string): Checked => ({ ok: false, reason });

/**
 * Every refusal of RFC 0015 section 1, in order. Reads, never writes. `write`
 * commands also refuse a `layout.json` whose `schemaVersion` this code doesn't
 * know; `status` reads it and reports.
 */
export function inspectRuntime(dir: string, ctx: RuntimeContext, write: boolean): Checked {
  if (ctx.uid === 0) {
    return refuse("browxai runtime does not run as root. Run it as the user who owns the runtime.");
  }
  const overlap = overlapReason(dir, ctx);
  if (overlap) return refuse(overlap);
  const top = checkDir(dir, "the runtime directory", ctx);
  if (top === "absent") return { ok: true, found: { kind: "absent" } };
  if (top !== "ok") return refuse(top);
  const entries = readdirSync(dir);
  if (entries.length === 0) return { ok: true, found: { kind: "empty" } };
  if (!entries.includes("layout.json")) return refuse(migrationSteps(dir));
  const schemaVersion = readSchemaVersion(join(dir, "layout.json"));
  if (schemaVersion === undefined) {
    return refuse(`${join(dir, "layout.json")} is not valid. Nothing was changed.`);
  }
  const known = schemaVersion === LAYOUT_SCHEMA_VERSION;
  if (!known && write) {
    return refuse(
      `${join(dir, "layout.json")} has schemaVersion ${schemaVersion}, and this browxai supports ${LAYOUT_SCHEMA_VERSION}. ` +
        "A newer browxai wrote this runtime: run its launcher instead.",
    );
  }
  const versions = checkDir(join(dir, "versions"), "versions/", ctx);
  if (versions !== "ok" && versions !== "absent") return refuse(versions);
  const foreign = foreignEntry(dir, ctx) ?? foreignEntry(join(dir, "versions"), ctx);
  if (foreign) return refuse(`${foreign} is owned by another user. Nothing was changed.`);
  return { ok: true, found: { kind: "managed", schemaVersion, known } };
}

/** `ok`, `absent`, or the refusal for a directory that must be a real directory
 *  owned by this user and writable by nobody else. `lstat`, so a symlink is seen. */
function checkDir(path: string, label: string, ctx: RuntimeContext): string {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  if (st.isSymbolicLink()) {
    return `${label} ${path} is a symlink. Use a real directory, or point BROWX_RUNTIME_DIR at the directory itself.`;
  }
  if (!st.isDirectory()) return `${label} ${path} is not a directory.`;
  if (ctx.uid !== undefined && st.uid !== ctx.uid) {
    return `${label} ${path} is owned by another user. Nothing was changed.`;
  }
  if (ctx.platform !== "win32" && (st.mode & 0o022) !== 0) {
    return `${label} ${path} is writable by group or others. Run: chmod go-w ${path}`;
  }
  return "ok";
}

/** The first entry directly under `dir` that another user owns, if any. */
function foreignEntry(dir: string, ctx: RuntimeContext): string | undefined {
  if (ctx.uid === undefined) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  return names.map((n) => join(dir, n)).find((p) => lstatSync(p).uid !== ctx.uid);
}

function readSchemaVersion(path: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const v = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The path with symlinks resolved as far as the path exists. */
function realish(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/**
 * Runtime code inside the workspace would let a tool that writes workspace files
 * plant code that runs at the next launch, so the two never overlap. The macOS
 * app's Application Support folder is the app's own and is refused too.
 */
function overlapReason(dir: string, ctx: RuntimeContext): string | undefined {
  const rt = realish(dir);
  const wsRaw = ctx.env.BROWX_WORKSPACE?.trim();
  const ws = realish(wsRaw ? expandHome(wsRaw, ctx.home) : join(ctx.home, ".browxai"));
  if (within(rt, ws) || within(ws, rt)) {
    return `the runtime directory ${dir} overlaps the workspace ${ws}. Keep them apart: set BROWX_RUNTIME_DIR or BROWX_WORKSPACE.`;
  }
  if (ctx.platform === "darwin") {
    const app = realish(join(ctx.home, "Library", "Application Support", "Browxai"));
    if (within(rt, app)) {
      return `the runtime directory ${dir} is inside the Browxai app's folder ${app}. Choose another directory.`;
    }
  }
  return undefined;
}

const RUNTIME_CLI =
  /^(.*)[\\/]versions[\\/][^\\/]+[\\/]node_modules[\\/]browxai[\\/]dist[\\/]cli\.js$/;

/**
 * The launcher to name in a client entry when this browxai runs from a runtime:
 * `BROWX_RUNTIME_DIR` is set (the launcher sets it), or the real path of `cli.js`
 * sits under `<runtime>/versions/`. Undefined otherwise, and when that runtime has
 * no `layout.json` or no launcher, so a stray variable never names a missing file.
 */
export function runtimeLauncherFor(distCli: string, env: NodeJS.ProcessEnv): string | undefined {
  let real = distCli;
  try {
    real = realpathSync(distCli);
  } catch {
    /* keep the path as given */
  }
  const fromEnv = env.BROWX_RUNTIME_DIR?.trim();
  const roots = [fromEnv && isAbsolute(fromEnv) ? fromEnv : undefined, RUNTIME_CLI.exec(real)?.[1]];
  for (const root of roots) {
    if (!root) continue;
    const paths = runtimePaths(root);
    if (existsSync(paths.layout) && existsSync(paths.shim)) return paths.shim;
  }
  return undefined;
}
