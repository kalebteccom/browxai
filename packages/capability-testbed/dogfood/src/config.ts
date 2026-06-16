import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HARNESS_CAPABILITIES } from "../../src/harness/manifest.js";

export type DriverMode = "live" | "mock";
export type CodexEffort = "low" | "medium" | "high" | "xhigh";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

export interface DogfoodRunConfig {
  readonly repoRoot: string;
  readonly packageRoot: string;
  readonly dogfoodRoot: string;
  readonly runId: string;
  readonly runRoot: string;
  readonly workspace: string;
  readonly tracesDir: string;
  readonly reportsDir: string;
  readonly browxaiSocket: string;
  readonly testbedPort: number | "auto";
  readonly testbedBaseUrl?: string;
  readonly mission: string;
  readonly kOverride?: number;
  readonly kDefault: number;
  readonly model: string;
  readonly effort: CodexEffort;
  readonly sandbox: CodexSandbox;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly timeoutMs: number;
  readonly oracleTimeoutMs: number;
  readonly maxToolCalls: number;
  readonly maxTurns: number;
  readonly codexBin: string;
  readonly headless: boolean;
  readonly keepOpen: boolean;
  readonly json: boolean;
  readonly mode: DriverMode;
  readonly runOracle: boolean;
  readonly browxaiCapabilities: readonly string[];
  readonly proxyCommand: string;
  readonly proxyArgsPrefix: readonly string[];
}

// Must be a model the driving Codex account supports. ChatGPT-account logins
// reject `gpt-5.3-codex` ("not supported when using Codex with a ChatGPT
// account"); `gpt-5.5` is the account's configured model. Override with --model.
export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_EFFORT: CodexEffort = "xhigh";
// "Yolo" for now (owner-authorized): full access + never-prompt so codex-cli
// 0.140.0 does not gate every browxai MCP tool call behind an approval/
// elicitation (read-only + the elicit gate rejected all calls as "user rejected
// MCP tool call"). The mission prompt (browxai tools only, no shell) is the
// behavioural guardrail; tighten the sandbox once the elicitation/trust path is
// validated. Mirrors remotxai's auto-accept permission model.
export const DEFAULT_SANDBOX: CodexSandbox = "danger-full-access";
export const DEFAULT_APPROVAL_POLICY: CodexApprovalPolicy = "never";
export const DEFAULT_K = 5;
export const DEFAULT_TIMEOUT_MS = 900_000;
export const DEFAULT_ORACLE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOOL_CALLS = 40;
export const DEFAULT_MAX_TURNS = 12;

function findPackageRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    const pkg = resolve(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown };
        if (parsed.name === "@browxai/capability-testbed") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("could not locate @browxai/capability-testbed package root");
    }
    dir = parent;
  }
}

export const PACKAGE_ROOT = findPackageRoot(process.cwd());
export const DOGFOOD_ROOT = resolve(PACKAGE_ROOT, "dogfood");
export const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

function nowRunId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${iso}-${randomBytes(3).toString("hex")}`;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return v;
}

function boolFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function parseEnum<T extends string>(raw: string, name: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} must be one of ${allowed.join(", ")}`);
}

function envOrFlag(
  args: readonly string[],
  flag: string,
  env: NodeJS.ProcessEnv,
  envName: string,
): string | undefined {
  return valueAfter(args, flag) ?? env[envName];
}

export function resolveDogfoodConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): DogfoodRunConfig {
  const runId = nowRunId();
  const runRoot = resolve(
    envOrFlag(argv, "--run-root", env, "DOGFOOD_RUN_ROOT") ?? resolve(DOGFOOD_ROOT, "runs", runId),
  );
  const workspace = resolve(
    valueAfter(argv, "--workspace") ?? env.BROWX_WORKSPACE ?? resolve(runRoot, "workspace"),
  );
  const socket = resolve(valueAfter(argv, "--browxai-socket") ?? resolve(runRoot, "browxai.sock"));
  const rawPort = envOrFlag(argv, "--testbed-port", env, "DOGFOOD_TESTBED_PORT") ?? "auto";
  const testbedPort =
    rawPort === "auto" ? "auto" : (parsePositiveInt(rawPort, "--testbed-port") ?? "auto");

  const rawHeadless = env.DOGFOOD_HEADLESS;
  const headless = boolFlag(argv, "--headless")
    ? true
    : boolFlag(argv, "--headed")
      ? false
      : rawHeadless === "1";

  const mode: DriverMode = boolFlag(argv, "--mock") ? "mock" : "live";
  const runOracle = mode === "live" && !boolFlag(argv, "--skip-oracle");

  return {
    repoRoot: REPO_ROOT,
    packageRoot: PACKAGE_ROOT,
    dogfoodRoot: DOGFOOD_ROOT,
    runId,
    runRoot,
    workspace,
    tracesDir: resolve(runRoot, "traces"),
    reportsDir: resolve(runRoot, "reports"),
    browxaiSocket: socket,
    testbedPort,
    mission: valueAfter(argv, "--mission") ?? "all",
    kOverride: parsePositiveInt(envOrFlag(argv, "--k", env, "DOGFOOD_K"), "--k"),
    kDefault: DEFAULT_K,
    model: envOrFlag(argv, "--model", env, "DOGFOOD_CODEX_MODEL") ?? DEFAULT_MODEL,
    effort: parseEnum(
      envOrFlag(argv, "--effort", env, "DOGFOOD_CODEX_EFFORT") ?? DEFAULT_EFFORT,
      "--effort",
      ["low", "medium", "high", "xhigh"] as const,
    ),
    sandbox: parseEnum(
      envOrFlag(argv, "--sandbox", env, "DOGFOOD_CODEX_SANDBOX") ?? DEFAULT_SANDBOX,
      "--sandbox",
      ["read-only", "workspace-write", "danger-full-access"] as const,
    ),
    approvalPolicy: parseEnum(
      envOrFlag(argv, "--approval-policy", env, "DOGFOOD_CODEX_APPROVAL_POLICY") ??
        DEFAULT_APPROVAL_POLICY,
      "--approval-policy",
      ["never", "on-request", "on-failure", "untrusted"] as const,
    ),
    timeoutMs:
      parsePositiveInt(valueAfter(argv, "--timeout-ms"), "--timeout-ms") ?? DEFAULT_TIMEOUT_MS,
    oracleTimeoutMs:
      parsePositiveInt(valueAfter(argv, "--oracle-timeout-ms"), "--oracle-timeout-ms") ??
      DEFAULT_ORACLE_TIMEOUT_MS,
    maxToolCalls:
      parsePositiveInt(envOrFlag(argv, "--max-tool-calls", env, "DOGFOOD_MAX_TOOL_CALLS"), "--max-tool-calls") ??
      DEFAULT_MAX_TOOL_CALLS,
    maxTurns:
      parsePositiveInt(envOrFlag(argv, "--max-turns", env, "DOGFOOD_MAX_TURNS"), "--max-turns") ??
      DEFAULT_MAX_TURNS,
    codexBin: envOrFlag(argv, "--codex-bin", env, "DOGFOOD_CODEX_BIN") ?? "codex",
    headless,
    keepOpen: boolFlag(argv, "--keep-open"),
    json: boolFlag(argv, "--json"),
    mode,
    runOracle,
    browxaiCapabilities: HARNESS_CAPABILITIES,
    proxyCommand: "node",
    proxyArgsPrefix: [
      resolve(PACKAGE_ROOT, "dogfood/dist/dogfood/src/runtime/browxai-socket-proxy.js"),
    ],
  };
}

export function hostRunCommand(): string {
  return [
    "node packages/capability-testbed/dogfood/bin/dogfood.js",
    "--mission forms-input-providers",
    "--k 1",
    "--max-tool-calls 25",
    "--max-turns 8",
    "--timeout-ms 300000",
  ].join(" ");
}
