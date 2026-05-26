// Pluggable credentials / TOTP hook (capability `credentials`, off by default).
//
// Why it exists: agents driving real auth flows routinely block on 2FA or
// stored-credential vault lookups. Without a hook here, the only escapes are
// (a) bake the seed/password into the prompt — which leaks into transcripts
// and eval datasets, defeating W-V12 secrets-masking — or (b) hand-fly the
// step every time. Substrate-tier solution: a thin provider abstraction that
// reads from a configured vault, with no provider bundled by default.
//
// Posture: same as `eval` / `network-body` / `secrets`. Off by default, loud
// one-time warning at boot. Provider selection is per-deployment — NEVER
// bundled, NEVER auto-purchased (see no-auto-purchases rule).
//
// Provider matrix (selected via `BROWX_CREDENTIALS_PROVIDER`):
//   - `oathtool`   default backend; shells out to the system `oathtool`
//                  binary against seeds supplied by the operator (env or
//                  config file). No paid dependency. If the binary is
//                  missing, every call returns a structured failure with an
//                  install hint (Homebrew / apt) — never auto-installed.
//   - `1password`  shells out to the `op` CLI. The operator must run
//                  `op signin` out-of-band; this module never prompts.
//   - `bitwarden`  shells out to the `bw` CLI. Same out-of-band auth model;
//                  expects `BW_SESSION` in the server env.
//   - `lastpass`   shells out to the `lpass` CLI. Same out-of-band auth.
//   - `none`       explicit no-op provider; both tools return a structured
//                  refusal. Useful when the capability is on for testing the
//                  surface without wiring a real vault.
//
// All shell invocations: fixed argv, no shell interpolation, account name
// is passed as a discrete argv element (no injection surface). stdout is
// captured to a string, stderr is captured to a string for failure
// diagnostics, no exec-via-shell paths.
//
// Integration with W-V12 secrets-masking: `get_credential` does NOT echo
// the password back in cleartext. It auto-registers the password into the
// per-session SecretRegistry under an alias derived from the account name
// (`<PASSWORD_<account>>`), and the returned object carries the alias —
// the agent then uses `fill({value:"<PASSWORD_acct>"})` and Playwright
// receives the real value at dispatch (W-V12 substitution). The egress-
// masking layer also catches the value in every other sink. `get_totp`
// returns the 6-digit code directly (TOTPs are single-use and short-lived
// — the value is "spent" the moment it's typed, so masking buys little
// and complicates the agent's verify-step flow).

import { spawn } from "node:child_process";
import type { SecretRegistry } from "./secrets.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProviderName = "oathtool" | "1password" | "bitwarden" | "lastpass" | "none";

export const ALL_PROVIDERS: readonly ProviderName[] = [
  "oathtool", "1password", "bitwarden", "lastpass", "none",
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
  /** The W-V12 alias the password is registered under, e.g. `PASSWORD_ACME`.
   *  The agent passes `<aliasName>` to `fill`/`press`; the runtime materialises
   *  the real value at dispatch. NEVER the cleartext password. */
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
        try { cp.kill("SIGKILL"); } catch { /* best-effort */ }
        finish({
          ok: false,
          stdout, stderr,
          code: null,
          spawnError: `timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
      cp.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      cp.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
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
        ok: false, stdout: "", stderr: "", code: null,
        spawnError: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Alias derivation
// ---------------------------------------------------------------------------

/** Turn an agent-facing account name into a W-V12 alias identifier.
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
// `none` provider — explicit no-op
// ---------------------------------------------------------------------------

class NoneProvider implements CredentialProvider {
  readonly name = "none" as const;
  async getTotp(_account: string): Promise<TotpResult> {
    return {
      ok: false,
      provider: "none",
      error: "credentials provider is `none` — no vault backend is configured",
      hint: "set BROWX_CREDENTIALS_PROVIDER to one of: oathtool, 1password, bitwarden, lastpass",
    };
  }
  async getCredential(_account: string): Promise<CredentialResult> {
    return {
      ok: false,
      provider: "none",
      error: "credentials provider is `none` — no vault backend is configured",
      hint: "set BROWX_CREDENTIALS_PROVIDER to one of: oathtool, 1password, bitwarden, lastpass",
    };
  }
}

// ---------------------------------------------------------------------------
// `oathtool` provider — self-managed TOTP seeds
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

class OathtoolProvider implements CredentialProvider {
  readonly name = "oathtool" as const;
  constructor(private readonly cfg: OathtoolConfig) {}
  async getTotp(account: string): Promise<TotpResult> {
    const seed = this.cfg.seeds[account];
    if (!seed) {
      return {
        ok: false,
        provider: "oathtool",
        error: `oathtool: no seed registered for account "${account}"`,
        hint:
          "register the seed via BROWX_OATHTOOL_SEEDS=\"<account>=<BASE32SECRET>,…\" or " +
          "BROWX_OATHTOOL_SEEDS_FILE=<path-to-json>, then restart the server",
      };
    }
    const binary = this.cfg.binary ?? "oathtool";
    // oathtool -b --totp <seed> — base32 input, default 6-digit, default 30s step
    const r = await runArgv([binary, "-b", "--totp", seed], { timeoutMs: 3000 });
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false,
        provider: "oathtool",
        error: `oathtool binary "${binary}" not found on PATH`,
        hint: "install oathtool (macOS: `brew install oath-toolkit`; Debian/Ubuntu: `apt install oathtool`)",
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        provider: "oathtool",
        error: `oathtool failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || r.spawnError || "check the seed value is valid BASE32",
      };
    }
    const code = r.stdout.trim();
    if (!/^\d{6,8}$/.test(code)) {
      return {
        ok: false,
        provider: "oathtool",
        error: `oathtool returned unexpected output (not a 6-8 digit code)`,
        hint: "verify the seed is BASE32 and oathtool's default options haven't been overridden",
      };
    }
    return { ok: true, code, provider: "oathtool" };
  }
  async getCredential(_account: string): Promise<CredentialResult> {
    return {
      ok: false,
      provider: "oathtool",
      error: "oathtool is a TOTP-only backend; it does not store username/password",
      hint: "pair with another provider for credential lookup (1password, bitwarden, lastpass)",
    };
  }
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
// `1password` provider — shells out to `op`
// ---------------------------------------------------------------------------

class OnePasswordProvider implements CredentialProvider {
  readonly name = "1password" as const;
  constructor(private readonly binary = "op") {}
  async getTotp(account: string): Promise<TotpResult> {
    const r = await runArgv([this.binary, "item", "get", account, "--otp"], { timeoutMs: 5000 });
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false, provider: "1password",
        error: `1password CLI "${this.binary}" not found on PATH`,
        hint: "install the 1Password CLI from https://developer.1password.com/docs/cli/get-started/",
      };
    }
    if (!r.ok) {
      return {
        ok: false, provider: "1password",
        error: `op item get --otp failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure you've run `op signin` and the item name is correct",
      };
    }
    const code = r.stdout.trim();
    if (!/^\d{6,8}$/.test(code)) {
      return {
        ok: false, provider: "1password",
        error: "1password returned unexpected output (not a 6-8 digit code)",
        hint: "verify the item has a one-time-password field configured",
      };
    }
    return { ok: true, code, provider: "1password" };
  }
  async getCredential(account: string): Promise<CredentialResult> {
    // `op item get <name> --fields label=username,label=password --format json`
    const r = await runArgv(
      [this.binary, "item", "get", account, "--fields", "label=username,label=password", "--format", "json"],
      { timeoutMs: 5000 },
    );
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false, provider: "1password",
        error: `1password CLI "${this.binary}" not found on PATH`,
        hint: "install the 1Password CLI from https://developer.1password.com/docs/cli/get-started/",
      };
    }
    if (!r.ok) {
      return {
        ok: false, provider: "1password",
        error: `op item get failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure you've run `op signin` and the item name is correct",
      };
    }
    const parsed = parseFieldsJson(r.stdout);
    if (!parsed.username || !parsed.password) {
      return {
        ok: false, provider: "1password",
        error: "1password item missing username or password field",
        hint: "verify the item has both a `username` and `password` field labelled accordingly",
      };
    }
    return { ok: true, provider: "1password", username: parsed.username, _password: parsed.password } as ProviderCredentialInternal;
  }
}

// ---------------------------------------------------------------------------
// `bitwarden` provider — shells out to `bw`
// ---------------------------------------------------------------------------

class BitwardenProvider implements CredentialProvider {
  readonly name = "bitwarden" as const;
  constructor(private readonly binary = "bw") {}
  async getTotp(account: string): Promise<TotpResult> {
    const r = await runArgv([this.binary, "get", "totp", account], { timeoutMs: 5000 });
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false, provider: "bitwarden",
        error: `bitwarden CLI "${this.binary}" not found on PATH`,
        hint: "install the Bitwarden CLI: https://bitwarden.com/help/cli/",
      };
    }
    if (!r.ok) {
      return {
        ok: false, provider: "bitwarden",
        error: `bw get totp failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure $BW_SESSION is set (`bw unlock`) and the item exists",
      };
    }
    const code = r.stdout.trim();
    if (!/^\d{6,8}$/.test(code)) {
      return {
        ok: false, provider: "bitwarden",
        error: "bitwarden returned unexpected output (not a 6-8 digit code)",
        hint: "verify the item has a TOTP field configured",
      };
    }
    return { ok: true, code, provider: "bitwarden" };
  }
  async getCredential(account: string): Promise<CredentialResult> {
    const r = await runArgv([this.binary, "get", "item", account], { timeoutMs: 5000 });
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false, provider: "bitwarden",
        error: `bitwarden CLI "${this.binary}" not found on PATH`,
        hint: "install the Bitwarden CLI: https://bitwarden.com/help/cli/",
      };
    }
    if (!r.ok) {
      return {
        ok: false, provider: "bitwarden",
        error: `bw get item failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure $BW_SESSION is set (`bw unlock`) and the item exists",
      };
    }
    try {
      const item = JSON.parse(r.stdout) as { login?: { username?: string; password?: string } };
      const username = item.login?.username;
      const password = item.login?.password;
      if (!username || !password) {
        return {
          ok: false, provider: "bitwarden",
          error: "bitwarden item missing username or password",
          hint: "verify the item has both fields populated",
        };
      }
      return { ok: true, provider: "bitwarden", username, _password: password } as ProviderCredentialInternal;
    } catch (e) {
      return {
        ok: false, provider: "bitwarden",
        error: "could not parse bw output as JSON",
        hint: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// `lastpass` provider — shells out to `lpass`
// ---------------------------------------------------------------------------

class LastpassProvider implements CredentialProvider {
  readonly name = "lastpass" as const;
  constructor(private readonly binary = "lpass") {}
  async getTotp(account: string): Promise<TotpResult> {
    const r = await runArgv([this.binary, "show", "--field=otp", account], { timeoutMs: 5000 });
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false, provider: "lastpass",
        error: `lastpass CLI "${this.binary}" not found on PATH`,
        hint: "install lpass (macOS: `brew install lastpass-cli`)",
      };
    }
    if (!r.ok) {
      return {
        ok: false, provider: "lastpass",
        error: `lpass show --field=otp failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure you've run `lpass login` and the item has an otp field",
      };
    }
    const code = r.stdout.trim();
    if (!/^\d{6,8}$/.test(code)) {
      return {
        ok: false, provider: "lastpass",
        error: "lastpass returned unexpected output (not a 6-8 digit code)",
        hint: "verify the item has a TOTP field configured",
      };
    }
    return { ok: true, code, provider: "lastpass" };
  }
  async getCredential(account: string): Promise<CredentialResult> {
    const r = await runArgv(
      [this.binary, "show", "--username", "--password", account],
      { timeoutMs: 5000 },
    );
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false, provider: "lastpass",
        error: `lastpass CLI "${this.binary}" not found on PATH`,
        hint: "install lpass (macOS: `brew install lastpass-cli`)",
      };
    }
    if (!r.ok) {
      return {
        ok: false, provider: "lastpass",
        error: `lpass show failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure you've run `lpass login` and the item exists",
      };
    }
    // lpass emits the requested fields one per line in the order requested.
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const [username, password] = lines;
    if (!username || !password) {
      return {
        ok: false, provider: "lastpass",
        error: "lastpass returned no username/password",
        hint: "verify the item has both fields populated",
      };
    }
    return { ok: true, provider: "lastpass", username, _password: password } as ProviderCredentialInternal;
  }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function parseFieldsJson(raw: string): { username?: string; password?: string } {
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

// ---------------------------------------------------------------------------
// Provider resolution + masking integration
// ---------------------------------------------------------------------------

/** Internal shape carrying the raw password out of a provider. The server
 *  layer reads `_password`, registers it into SecretRegistry, and returns
 *  the aliasName-bearing public shape. The `_password` field is stripped
 *  before any response is serialised. */
export type ProviderCredentialInternal = CredentialResult & { _password?: string };

export interface CredentialsConfig {
  provider: ProviderName;
  warnings: readonly string[];
}

/**
 * Resolve the configured provider from env. Returns the provider singleton
 * + any non-fatal startup warnings (the caller logs these via `log.warn`).
 *
 * Env contract:
 *   BROWX_CREDENTIALS_PROVIDER=oathtool|1password|bitwarden|lastpass|none
 *   BROWX_OATHTOOL_BIN=/custom/path/to/oathtool
 *   BROWX_OATHTOOL_SEEDS="acct1=BASE32,acct2=BASE32"
 *   BROWX_1PASSWORD_BIN=/custom/path/to/op
 *   BROWX_BITWARDEN_BIN=/custom/path/to/bw
 *   BROWX_LASTPASS_BIN=/custom/path/to/lpass
 *
 * Default is `oathtool` (the self-managed, no-paid-dependency path). The
 * provider object is constructed eagerly; if its CLI is missing, that
 * surfaces per-call, never at startup (so the server still boots).
 */
export function resolveCredentialsProvider(
  env: NodeJS.ProcessEnv = process.env,
): { provider: CredentialProvider; config: CredentialsConfig } {
  const raw = env.BROWX_CREDENTIALS_PROVIDER?.trim().toLowerCase();
  const warnings: string[] = [];
  const name: ProviderName = (() => {
    if (!raw) return "oathtool";
    if (ALL_PROVIDERS.includes(raw as ProviderName)) return raw as ProviderName;
    warnings.push(
      `BROWX_CREDENTIALS_PROVIDER: unknown provider "${raw}" — falling back to "oathtool". ` +
      `Valid: ${ALL_PROVIDERS.join(", ")}.`,
    );
    return "oathtool";
  })();
  let provider: CredentialProvider;
  switch (name) {
    case "oathtool": {
      const seeds = parseSeedsEnv(env.BROWX_OATHTOOL_SEEDS);
      provider = new OathtoolProvider({
        binary: env.BROWX_OATHTOOL_BIN?.trim() || undefined,
        seeds,
      });
      break;
    }
    case "1password":
      provider = new OnePasswordProvider(env.BROWX_1PASSWORD_BIN?.trim() || undefined);
      break;
    case "bitwarden":
      provider = new BitwardenProvider(env.BROWX_BITWARDEN_BIN?.trim() || undefined);
      break;
    case "lastpass":
      provider = new LastpassProvider(env.BROWX_LASTPASS_BIN?.trim() || undefined);
      break;
    case "none":
      provider = new NoneProvider();
      break;
  }
  return { provider, config: { provider: name, warnings } };
}

/**
 * Test seam: build a provider instance directly from a callable pair.
 * Used by the test suite to mock both endpoints without spawning a real
 * binary. Not exported for runtime use.
 */
export function makeFakeProvider(
  impl: {
    getTotp: (account: string) => Promise<TotpResult>;
    getCredential: (account: string) => Promise<CredentialResult>;
  },
  name: ProviderName = "oathtool",
): CredentialProvider {
  return { name, getTotp: impl.getTotp, getCredential: impl.getCredential };
}

/**
 * Apply a credential lookup to the W-V12 secrets registry on the session:
 * registers the password under an account-derived alias, then returns the
 * public credential shape (username + aliasName only, NEVER the password).
 *
 * Callers pass `registry` only when the `secrets` capability is enabled.
 * When it's not, the function returns a structured refusal — registering
 * a password without the egress-masking layer engaged would leak the
 * password into transcripts the first time the agent referenced it.
 */
export function applyCredentialToRegistry(
  result: ProviderCredentialInternal,
  registry: SecretRegistry | null,
  account: string,
  pageUrl?: string,
): CredentialResult {
  if (!result.ok) {
    // Surface refusal verbatim; never carries a password.
    return stripInternal(result);
  }
  if (!result._password || !result.username) {
    return {
      ok: false,
      provider: result.provider,
      error: "provider returned incomplete credential (missing username or password)",
    };
  }
  if (!registry) {
    return {
      ok: false,
      provider: result.provider,
      error:
        "credentials lookup refused: the `secrets` capability is not enabled. " +
        "Returning a password without secrets-masking would leak it into transcripts. " +
        "Add `secrets` to BROWX_CAPABILITIES alongside `credentials`, then restart.",
    };
  }
  const aliasName = aliasFromAccount(account);
  try {
    registry.register({
      name: aliasName,
      value: result._password,
      ...(pageUrl ? {} : {}),
    });
  } catch (e) {
    return {
      ok: false,
      provider: result.provider,
      error: `could not register password into secrets registry: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return {
    ok: true,
    provider: result.provider,
    username: result.username,
    aliasName,
  };
}

function stripInternal(r: ProviderCredentialInternal): CredentialResult {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _password, ...rest } = r;
  return rest;
}
