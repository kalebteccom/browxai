// `browxai browser install` - first-party browser binary setup.
//
// This wraps the installed playwright-core CLI by absolute path. It does not use
// npx, a global Playwright install, or package-manager scripts, so the downloaded
// browser revision is tied to this browxai package's pinned dependency graph.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, firefox, webkit } from "playwright-core";
import { PACKAGE_VERSION } from "../util/version.js";

type InstallEngine = "chromium" | "firefox" | "webkit";

interface BrowserDescriptor {
  name: string;
  revision: string;
  browserVersion?: string;
  title?: string;
}

interface BrowserInstallPlan {
  engines: InstallEngine[];
  force: boolean;
  dryRun: boolean;
  withDeps: boolean;
}

const INSTALL_ENGINES: readonly InstallEngine[] = ["chromium", "firefox", "webkit"];
const NON_PLAYWRIGHT_DOWNLOAD_ENGINES = new Set(["android", "safari"]);
const EXECUTABLE_PATH_FOR: Record<InstallEngine, () => string> = {
  chromium: () => chromium.executablePath(),
  firefox: () => firefox.executablePath(),
  webkit: () => webkit.executablePath(),
};

const USAGE = `usage: browxai browser install [--engine chromium|firefox|webkit | --all] [--force] [--dry-run] [--with-deps]

Examples:
  browxai browser install
  browxai browser install --engine chromium
  browxai browser install --all
`;

const require = createRequire(import.meta.url);

export async function runBrowser(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "install") return installBrowser(args.slice(1));
  process.stderr.write(USAGE);
  return 2;
}

export function parseBrowserInstallArgs(args: readonly string[]): BrowserInstallPlan {
  let engine: InstallEngine | undefined;
  let all = false;
  let force = false;
  let dryRun = false;
  let withDeps = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--with-deps") {
      withDeps = true;
      continue;
    }
    if (arg === "--engine") {
      const value = args[++i];
      if (!value) throw new Error("--engine requires a value");
      engine = parseInstallEngine(value);
      continue;
    }
    if (arg?.startsWith("--engine=")) {
      engine = parseInstallEngine(arg.slice("--engine=".length));
      continue;
    }
    throw new Error(`unknown browser install option "${arg}"`);
  }

  if (all && engine) throw new Error("pass either --all or --engine, not both");
  return {
    engines: all ? [...INSTALL_ENGINES] : [engine ?? "chromium"],
    force,
    dryRun,
    withDeps,
  };
}

async function installBrowser(args: string[]): Promise<number> {
  let plan: BrowserInstallPlan;
  try {
    plan = parseBrowserInstallArgs(args);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }

  const playwrightVersion = playwrightPackageVersion();
  const descriptors = browserDescriptors();
  process.stdout.write(
    [
      "browxai browser install",
      `  browxai:         ${PACKAGE_VERSION}`,
      `  playwright-core: ${playwrightVersion}`,
      `  engines:         ${plan.engines.join(", ")}`,
      `  download host:   ${downloadHost(plan.engines)}`,
      "",
      ...plan.engines.map((engine) => browserDetail(engine, descriptors)),
      "",
    ].join("\n"),
  );

  const missing = plan.engines.filter((engine) => !existsSync(executablePathFor(engine)));
  if (missing.length === 0 && !plan.force && !plan.dryRun && !plan.withDeps) {
    process.stdout.write("ready: all selected browser binaries are already installed.\n");
    return 0;
  }

  const cliPath = require.resolve("playwright-core/cli.js");
  const cliArgs = [cliPath, "install"];
  if (plan.withDeps) cliArgs.push("--with-deps");
  if (plan.dryRun) cliArgs.push("--dry-run");
  if (plan.force) cliArgs.push("--force");
  cliArgs.push(...plan.engines);

  return await spawnAndWait(process.execPath, cliArgs);
}

function parseInstallEngine(value: string): InstallEngine {
  if ((INSTALL_ENGINES as readonly string[]).includes(value)) return value as InstallEngine;
  if (NON_PLAYWRIGHT_DOWNLOAD_ENGINES.has(value)) {
    throw new Error(
      `engine "${value}" does not use Playwright browser downloads; choose chromium, firefox, webkit, or --all`,
    );
  }
  throw new Error(`unknown browser engine "${value}"; choose chromium, firefox, webkit, or --all`);
}

function playwrightPackageVersion(): string {
  const pkgPath = require.resolve("playwright-core/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
}

function browserDescriptors(): Map<string, BrowserDescriptor> {
  const pkgDir = dirname(require.resolve("playwright-core/package.json"));
  const raw = JSON.parse(readFileSync(join(pkgDir, "browsers.json"), "utf8")) as {
    browsers?: BrowserDescriptor[];
  };
  return new Map((raw.browsers ?? []).map((entry) => [entry.name, entry]));
}

function browserDetail(
  engine: InstallEngine,
  descriptors: ReadonlyMap<string, BrowserDescriptor>,
): string {
  const descriptor = descriptors.get(engine);
  const version = descriptor?.browserVersion ? `, browser ${descriptor.browserVersion}` : "";
  const revision = descriptor?.revision
    ? `revision ${descriptor.revision}${version}`
    : "revision unknown";
  return `  ${engine}: ${revision}\n    executable: ${executablePathFor(engine)}`;
}

function executablePathFor(engine: InstallEngine): string {
  return EXECUTABLE_PATH_FOR[engine]();
}

function downloadHost(engines: readonly InstallEngine[]): string {
  const browserHosts = engines
    .map((engine) => process.env[`PLAYWRIGHT_${engine.toUpperCase()}_DOWNLOAD_HOST`])
    .filter((value): value is string => !!value);
  return browserHosts[0] ?? process.env.PLAYWRIGHT_DOWNLOAD_HOST ?? "Playwright CDN default";
}

async function spawnAndWait(command: string, args: string[]): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", (err) => {
      process.stderr.write(`failed to run playwright-core installer: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
