// Credentials port contract — the shared leaf for the credentials capability.
//
// Why this is its own file: both the barrel (`credentials.ts`, which owns the
// SecretRegistry integration) and the provider adapters (`credentials-providers.ts`)
// need these primitives. Keeping them in a dependency-free leaf — importing only
// `node:child_process` — means neither side has to reach back through the barrel,
// so there is no import cycle.
//
// All shell invocations: fixed argv, no shell interpolation, account name
// is passed as a discrete argv element (no injection surface). stdout is
// captured to a string, stderr is captured to a string for failure
// diagnostics, no exec-via-shell paths.

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProviderName = "oathtool" | "1password" | "bitwarden" | "lastpass" | "none";

export const ALL_PROVIDERS: readonly ProviderName[] = [
  "oathtool",
  "1password",
  "bitwarden",
  "lastpass",
  "none",
];

/**
 * Result of a TOTP lookup. `ok:false` carries a structured `error` + `hint`
 * (typically the install / signin instruction) the tool layer surfaces back
 * to the agent. The real code never appears in `error`.
 */
export interface TotpResult {
  ok: boolean;
  /** The 6 (or 8) digit one-time code, present iff `ok:true`. */
  code?: string;
  error?: string;
  hint?: string;
  /** Echo back the provider so the agent can confirm what backend answered. */
  provider: ProviderName;
}

/**
 * Result of a credential lookup. On success the `username` is plaintext —
 * usernames aren't secret. The `password` is NEVER returned in cleartext;
 * it's auto-registered into the per-session SecretRegistry under
 * `aliasName`, and the caller substitutes it via `fill({value:"<NAME>"})`.
 */
export interface CredentialResult {
  ok: boolean;
  username?: string;
  /** The SecretRegistry alias the password is registered under, e.g.
   *  `PASSWORD_ACME`. The agent passes `<aliasName>` to `fill`/`press`; the
   *  runtime materialises the real value at dispatch. NEVER the cleartext
   *  password. */
  aliasName?: string;
  error?: string;
  hint?: string;
  provider: ProviderName;
}

/**
 * The pluggable provider contract. Implementations are stateless w.r.t.
 * browxai sessions — provider config lives in env / config file resolved
 * at server start. `account` is the agent-facing identifier (e.g. an
 * `op` item name, a Bitwarden item id, or an oathtool seed key); semantics
 * are provider-specific.
 */
export interface CredentialProvider {
  readonly name: ProviderName;
  getTotp(account: string): Promise<TotpResult>;
  getCredential(account: string): Promise<CredentialResult>;
}

/** Internal shape carrying the raw password out of a provider. The server
 *  layer reads `_password`, registers it into SecretRegistry, and returns
 *  the aliasName-bearing public shape. The `_password` field is stripped
 *  before any response is serialised. */
export type ProviderCredentialInternal = CredentialResult & { _password?: string };

// ---------------------------------------------------------------------------
// Shell helper — fixed argv, no shell interpolation
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  /** Set when the binary itself couldn't be spawned (ENOENT etc). */
  spawnError?: string;
}

/** Spawn a process with fixed argv (no shell). Returns combined result.
 *  Bounded by a 5s wall-clock — a hung CLI shouldn't block tool dispatch. */
export async function runArgv(
  argv: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; stdin?: string } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const cp = spawn(argv[0]!, argv.slice(1), {
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          cp.kill("SIGKILL");
        } catch {
          /* best-effort */
        }
        finish({
          ok: false,
          stdout,
          stderr,
          code: null,
          spawnError: `timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
      cp.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      cp.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      cp.on("error", (e) => {
        clearTimeout(timer);
        finish({ ok: false, stdout, stderr, code: null, spawnError: e.message });
      });
      cp.on("close", (code) => {
        clearTimeout(timer);
        finish({ ok: code === 0, stdout, stderr, code });
      });
      if (opts.stdin !== undefined) cp.stdin.end(opts.stdin);
      else cp.stdin.end();
    } catch (e) {
      finish({
        ok: false,
        stdout: "",
        stderr: "",
        code: null,
        spawnError: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Alias derivation
// ---------------------------------------------------------------------------

/** Turn an agent-facing account name into a SecretRegistry alias identifier.
 *  Result always matches `/^[A-Z][A-Z0-9_]*$/`. */
export function aliasFromAccount(account: string, prefix = "PASSWORD"): string {
  const sanitised = account
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!sanitised) return prefix;
  // Guarantee leading letter (regex needs `[A-Z]` first).
  const head = /^[A-Z]/.test(sanitised) ? sanitised : `X_${sanitised}`;
  return `${prefix}_${head}`;
}

// ---------------------------------------------------------------------------
// oathtool seed config + env parsing
// ---------------------------------------------------------------------------

/**
 * Seeds for the oathtool backend. The operator supplies seeds via env:
 *   BROWX_OATHTOOL_SEEDS=acct1=BASE32SECRET,acct2=BASE32SECRET
 * or via JSON file:
 *   BROWX_OATHTOOL_SEEDS_FILE=/path/to/seeds.json   # {"acct1":"BASE32SECRET",…}
 *
 * Seeds are loaded ONCE at server start and held in memory. The seeds map
 * is NOT exposed via any tool — the agent only ever knows the account
 * name, never the seed. `get_credential` is not supported by this provider
 * (oathtool is TOTP-only; pair with another vault for username/password).
 */
export interface OathtoolConfig {
  binary?: string;
  seeds: Readonly<Record<string, string>>;
}

/** Parse `acct1=SEED1,acct2=SEED2` into a record. Tolerates whitespace,
 *  rejects malformed entries silently (returns what parses). Internal — the
 *  full resolution flow surfaces a clean warning when nothing parses. */
export function parseSeedsEnv(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export function parseFieldsJson(raw: string): { username?: string; password?: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    // `op item get --fields label=username,label=password --format json` emits
    // an array of `{label, value, …}` entries.
    if (Array.isArray(parsed)) {
      const out: { username?: string; password?: string } = {};
      for (const entry of parsed) {
        const e = entry as { label?: string; value?: string };
        if (e.label === "username" && typeof e.value === "string") out.username = e.value;
        if (e.label === "password" && typeof e.value === "string") out.password = e.value;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}
