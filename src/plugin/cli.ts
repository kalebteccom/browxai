// `browxai plugin` CLI subcommands — install, remove, list, info,
// upgrade, sync. Shells out to `pnpm` (which the project already
// declares as the package manager) against the workspace-rooted
// install dir. Never auto-restarts the server — every command emits a
// "Server restart required" advisory.
//
// Reproducibility surface:
//   - <workspace>/plugins.json         declarative truth
//   - <workspace>/plugins-lock.json    auto-generated pin + sha256
//   - <workspace>/plugins/             install dir (with node_modules/)
//
// The lock file format is documented inline below — kept small and
// hand-readable.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveWorkspace } from "../util/workspace.js";
import { log } from "../util/logging.js";
import { pluginPaths, type PluginPaths } from "./resolver.js";

const RESTART_NOTICE =
  "Server restart required — plugins are resolved ONCE at server start, so changes only take effect after a fresh `browxai` start.";

interface LockEntry {
  /** npm package name. */
  readonly name: string;
  /** Installed version (read from the package's package.json after install). */
  readonly version: string;
  /** Where the package was installed from (`npm`, `file:./path`, etc.). */
  readonly source: string;
  /** sha256 over the package's package.json + main entry — the
   *  reproducibility pin. Mismatch on next install means the underlying
   *  package contents changed. */
  readonly contentSha256: string;
}

interface LockFile {
  /** Version of the lock format itself. Bumped on incompatible change. */
  readonly lockfileVersion: 1;
  /** Entries keyed by package name. */
  readonly entries: Record<string, LockEntry>;
}

function readPluginsJson(paths: PluginPaths): {
  plugins: Record<string, { enabled?: boolean; trust?: string }>;
} {
  if (!existsSync(paths.declarationFile)) return { plugins: {} };
  try {
    const raw = JSON.parse(readFileSync(paths.declarationFile, "utf8")) as unknown;
    if (raw && typeof raw === "object" && raw !== null) {
      const r = raw as { plugins?: unknown };
      if (Array.isArray(r.plugins)) {
        // Normalise array → object form.
        const obj: Record<string, { enabled?: boolean; trust?: string }> = {};
        for (const n of r.plugins) {
          if (typeof n === "string") obj[n] = { enabled: true };
        }
        return { plugins: obj };
      }
      if (r.plugins && typeof r.plugins === "object") {
        return { plugins: r.plugins as Record<string, { enabled?: boolean; trust?: string }> };
      }
    }
  } catch {
    /* fall through */
  }
  return { plugins: {} };
}

function writePluginsJson(
  paths: PluginPaths,
  data: { plugins: Record<string, { enabled?: boolean; trust?: string }> },
): void {
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.declarationFile, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readLock(paths: PluginPaths): LockFile {
  if (!existsSync(paths.lockFile)) return { lockfileVersion: 1, entries: {} };
  try {
    const raw = JSON.parse(readFileSync(paths.lockFile, "utf8")) as Partial<LockFile>;
    if (raw && raw.lockfileVersion === 1 && raw.entries) {
      return { lockfileVersion: 1, entries: raw.entries };
    }
  } catch {
    /* fall through */
  }
  return { lockfileVersion: 1, entries: {} };
}

function writeLock(paths: PluginPaths, data: LockFile): void {
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.lockFile, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function sha256OfPackage(pkgRoot: string): string {
  const hash = createHash("sha256");
  // Hash package.json verbatim + every file referenced by `files`/`main`/
  // `browxai.register`. Falls back to walking package.json + main entry
  // when the field isn't there. Keep small + deterministic.
  const pkgJsonPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgJsonPath)) return "";
  const pkgJson = readFileSync(pkgJsonPath);
  hash.update(pkgJson);
  try {
    const parsed = JSON.parse(pkgJson.toString("utf8")) as {
      browxai?: { register?: string };
      main?: string;
      files?: string[];
    };
    const targets = new Set<string>();
    if (parsed.browxai?.register) targets.add(parsed.browxai.register);
    if (parsed.main) targets.add(parsed.main);
    for (const f of parsed.files ?? []) targets.add(f);
    for (const rel of [...targets].sort()) {
      const abs = join(pkgRoot, rel);
      if (!existsSync(abs)) continue;
      const st = statSync(abs);
      if (st.isFile()) {
        hash.update(rel);
        hash.update(readFileSync(abs));
      } else if (st.isDirectory()) {
        for (const sub of walkDir(abs)) {
          const subRel = relative(pkgRoot, sub).split(sep).join("/");
          hash.update(subRel);
          hash.update(readFileSync(sub));
        }
      }
    }
  } catch {
    /* fall through — partial hash is still meaningful for drift detection */
  }
  return hash.digest("hex");
}

function* walkDir(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile()) yield p;
    else if (entry.isDirectory()) yield* walkDir(p);
  }
}

async function runPnpm(paths: PluginPaths, args: ReadonlyArray<string>): Promise<number> {
  // paths.installDir is workspace-rooted by construction (see
  // pluginPaths() in resolver.ts — `<workspace>/plugins/`).
  mkdirSync(paths.installDir, { recursive: true });
  // Create a stub package.json so pnpm has a workspace root to write into.
  const stub = join(paths.installDir, "package.json");
  if (!existsSync(stub)) {
    writeFileSync(
      stub,
      JSON.stringify({ name: "browxai-plugins", version: "0.0.0", private: true }, null, 2) + "\n",
      "utf8",
    );
  }
  return new Promise<number>((resolve) => {
    const child = spawn("pnpm", [...args], {
      cwd: paths.installDir,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      log.error(`browxai plugin: pnpm spawn failed — ${err.message}`);
      resolve(127);
    });
  });
}

/**
 * Pin entry for `plugins-lock.json` — recompute version + sha256 after
 * an install / upgrade / sync operation.
 */
function pinEntry(paths: PluginPaths, name: string, source: string): LockEntry | null {
  const pkgRoot = join(paths.nodeModulesDir, name);
  const pkgJsonPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string };
    return {
      name,
      version: parsed.version ?? "0.0.0",
      source,
      contentSha256: sha256OfPackage(pkgRoot),
    };
  } catch {
    return null;
  }
}

function inferTrustFromSource(source: string): "kalebtec" | "community" | "local" {
  if (source.startsWith("file:")) return "local";
  if (source.startsWith("@kalebtec/")) return "kalebtec";
  return "community";
}

/** Resolve the plugin name a `pnpm add` spec installs.
 *  Heuristic: drop a leading `file:` (the dir name is what npm uses);
 *  otherwise strip a trailing `@<version>` range. The CLI logs the
 *  resolved name before writing it to plugins.json so an operator can
 *  see what was added. */
function resolveInstalledName(source: string): string {
  if (source.startsWith("file:")) {
    const rel = source.slice("file:".length).replace(/\/+$/, "");
    const base = rel.split("/").pop() ?? rel;
    // For file: installs, the actual installed name in node_modules is
    // the package's `name` field — not the directory base. Walk
    // node_modules afterward and find the match. Best-effort fallback:
    // use the dir base if the package.json isn't reachable yet.
    return base;
  }
  // Strip trailing `@version` (but tolerate scoped names that start with `@`).
  const at = source.lastIndexOf("@");
  if (at <= 0) return source;
  // e.g. `@scope/pkg@^1.0.0` → keep `@scope/pkg`
  return source.slice(0, at);
}

function findActualPackageName(paths: PluginPaths, hint: string): string {
  // For file: installs the directory base may not match the package
  // name — walk node_modules looking for a package.json whose own
  // path matches.
  const direct = join(paths.nodeModulesDir, hint, "package.json");
  if (existsSync(direct)) return hint;
  // Scoped: search one level deeper.
  if (existsSync(paths.nodeModulesDir)) {
    for (const entry of readdirSync(paths.nodeModulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scopeDir = join(paths.nodeModulesDir, entry.name);
        for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            const full = `${entry.name}/${sub.name}`;
            const pj = join(paths.nodeModulesDir, full, "package.json");
            if (existsSync(pj)) {
              try {
                const parsed = JSON.parse(readFileSync(pj, "utf8")) as { name?: string };
                if (parsed.name === hint || sub.name === hint) return full;
              } catch {
                /* */
              }
            }
          }
        }
      } else {
        const pj = join(paths.nodeModulesDir, entry.name, "package.json");
        if (existsSync(pj)) {
          try {
            const parsed = JSON.parse(readFileSync(pj, "utf8")) as { name?: string };
            if (parsed.name === hint) return entry.name;
          } catch {
            /* */
          }
        }
      }
    }
  }
  return hint;
}

async function cmdInstall(spec: string): Promise<number> {
  const ws = resolveWorkspace();
  const paths = pluginPaths(ws.root);
  process.stderr.write(`browxai plugin: installing "${spec}" into ${paths.installDir}\n`);
  const code = await runPnpm(paths, ["add", spec]);
  if (code !== 0) {
    process.stderr.write(`browxai plugin: pnpm add failed (exit ${code})\n`);
    return code;
  }
  const hintName = resolveInstalledName(spec);
  const name = findActualPackageName(paths, hintName);
  // Persist into plugins.json.
  const data = readPluginsJson(paths);
  const trust = inferTrustFromSource(spec.startsWith("file:") ? spec : name);
  data.plugins[name] = { enabled: true, ...(trust === "local" ? { trust: "local" } : {}) };
  writePluginsJson(paths, data);
  // Persist into plugins-lock.json.
  const lock = readLock(paths);
  const pinned = pinEntry(paths, name, spec);
  if (pinned) lock.entries[name] = pinned;
  writeLock(paths, lock);
  process.stderr.write(
    `browxai plugin: installed ${name}@${pinned?.version ?? "?"} (trust=${trust})\n`,
  );
  process.stderr.write(`browxai plugin: ${RESTART_NOTICE}\n`);
  return 0;
}

async function cmdRemove(name: string): Promise<number> {
  const ws = resolveWorkspace();
  const paths = pluginPaths(ws.root);
  process.stderr.write(`browxai plugin: removing "${name}"\n`);
  const code = await runPnpm(paths, ["remove", name]);
  if (code !== 0) {
    process.stderr.write(`browxai plugin: pnpm remove failed (exit ${code})\n`);
    return code;
  }
  const data = readPluginsJson(paths);
  delete data.plugins[name];
  writePluginsJson(paths, data);
  const lock = readLock(paths);
  delete lock.entries[name];
  writeLock(paths, lock);
  process.stderr.write(`browxai plugin: removed ${name}\n`);
  process.stderr.write(`browxai plugin: ${RESTART_NOTICE}\n`);
  return 0;
}

function cmdList(): number {
  const ws = resolveWorkspace();
  const paths = pluginPaths(ws.root);
  const data = readPluginsJson(paths);
  const lock = readLock(paths);
  const names = Object.keys(data.plugins).sort();
  if (names.length === 0) {
    process.stdout.write("browxai plugin: no plugins declared\n");
    return 0;
  }
  process.stdout.write(`browxai plugin: ${names.length} declared\n`);
  for (const name of names) {
    const entry = data.plugins[name]!;
    const pin = lock.entries[name];
    const installed = pin ? `${pin.version}` : "(not installed)";
    const enabled = entry.enabled === false ? " [disabled]" : "";
    const trust = entry.trust ? ` trust=${entry.trust}` : "";
    process.stdout.write(`  - ${name}@${installed}${trust}${enabled}\n`);
  }
  return 0;
}

function cmdInfo(name: string): number {
  const ws = resolveWorkspace();
  const paths = pluginPaths(ws.root);
  const data = readPluginsJson(paths);
  const lock = readLock(paths);
  const entry = data.plugins[name];
  if (!entry) {
    process.stderr.write(`browxai plugin: "${name}" is not declared in plugins.json\n`);
    return 1;
  }
  const pkgJsonPath = join(paths.nodeModulesDir, name, "package.json");
  let manifestSummary: unknown = null;
  if (existsSync(pkgJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        name?: string;
        version?: string;
        description?: string;
        browxai?: unknown;
      };
      manifestSummary = {
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        browxai: parsed.browxai,
      };
    } catch {
      manifestSummary = { error: "package.json malformed" };
    }
  }
  const info = {
    declared: entry,
    lock: lock.entries[name] ?? null,
    manifest: manifestSummary,
    notes:
      manifestSummary === null
        ? "Not installed. Run `browxai plugin install` or `browxai plugin sync`."
        : null,
  };
  process.stdout.write(JSON.stringify(info, null, 2) + "\n");
  return 0;
}

async function cmdUpgrade(name: string | undefined): Promise<number> {
  const ws = resolveWorkspace();
  const paths = pluginPaths(ws.root);
  const args = name ? ["update", name] : ["update"];
  process.stderr.write(`browxai plugin: ${name ? `upgrading ${name}` : "upgrading all"}\n`);
  const code = await runPnpm(paths, args);
  if (code !== 0) {
    process.stderr.write(`browxai plugin: pnpm update failed (exit ${code})\n`);
    return code;
  }
  // Re-pin the lock for affected entries.
  const lock = readLock(paths);
  const targets = name ? [name] : Object.keys(lock.entries);
  for (const t of targets) {
    const prevSource = lock.entries[t]?.source ?? t;
    const pinned = pinEntry(paths, t, prevSource);
    if (pinned) lock.entries[t] = pinned;
  }
  writeLock(paths, lock);
  process.stderr.write(`browxai plugin: ${RESTART_NOTICE}\n`);
  return 0;
}

async function cmdSync(): Promise<number> {
  const ws = resolveWorkspace();
  const paths = pluginPaths(ws.root);
  const data = readPluginsJson(paths);
  const declared = Object.keys(data.plugins);
  if (declared.length === 0) {
    process.stdout.write("browxai plugin: nothing to sync (no plugins declared)\n");
    return 0;
  }
  process.stderr.write(`browxai plugin: syncing ${declared.length} declared plugin(s)\n`);
  // Run a single `pnpm install <pkg> ...` so pnpm reconciles everything
  // against the install dir's package.json. For file: entries we don't
  // know the original spec — fall back to plain `pnpm install` which
  // reads the install dir's package.json.
  const code = await runPnpm(paths, ["install"]);
  if (code !== 0) {
    process.stderr.write(`browxai plugin: pnpm install failed (exit ${code})\n`);
    return code;
  }
  // Refresh lock for everything.
  const lock = readLock(paths);
  for (const name of declared) {
    const prevSource = lock.entries[name]?.source ?? name;
    const pinned = pinEntry(paths, name, prevSource);
    if (pinned) lock.entries[name] = pinned;
  }
  writeLock(paths, lock);
  process.stderr.write(`browxai plugin: sync done. ${RESTART_NOTICE}\n`);
  return 0;
}

function help(): number {
  process.stdout.write(
    `Usage: browxai plugin <subcommand>\n\n` +
      `  install <pkg>     install a plugin from npm (or file:./path) into the workspace\n` +
      `  remove <pkg>      remove a plugin\n` +
      `  list              list declared plugins\n` +
      `  info <pkg>        full manifest + lock entry for one plugin\n` +
      `  upgrade [<pkg>]   upgrade one plugin (or all when omitted)\n` +
      `  sync              reconcile installed node_modules with plugins.json\n\n` +
      `Every command writes to <workspace>/. Plugin lifecycle is\n` +
      `resolved ONCE at server start — restart the server after any change.\n`,
  );
  return 0;
}

/** CLI dispatcher — invoked by `src/cli.ts` for the `plugin` subcommand. */
export async function runPlugin(args: ReadonlyArray<string>): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return help();
    case "install":
      if (!rest[0]) {
        process.stderr.write("browxai plugin install: missing <pkg> argument\n");
        return 1;
      }
      return cmdInstall(rest[0]);
    case "remove":
      if (!rest[0]) {
        process.stderr.write("browxai plugin remove: missing <pkg> argument\n");
        return 1;
      }
      return cmdRemove(rest[0]);
    case "list":
      return cmdList();
    case "info":
      if (!rest[0]) {
        process.stderr.write("browxai plugin info: missing <pkg> argument\n");
        return 1;
      }
      return cmdInfo(rest[0]);
    case "upgrade":
      return cmdUpgrade(rest[0]);
    case "sync":
      return cmdSync();
    default:
      process.stderr.write(`browxai plugin: unknown subcommand "${sub}"\n`);
      help();
      return 2;
  }
}
