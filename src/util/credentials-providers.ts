// Credentials provider adapters — the five vendor backends + resolution.
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
// The five provider classes stay unexported — only `resolveCredentialsProvider`
// (and the test seam `makeFakeProvider`) hand them to callers as the
// `CredentialProvider` interface.

import {
  ALL_PROVIDERS,
  parseFieldsJson,
  parseSeedsEnv,
  runArgv,
  type CredentialProvider,
  type CredentialResult,
  type OathtoolConfig,
  type ProviderCredentialInternal,
  type ProviderName,
  type TotpResult,
} from "./credentials-contract.js";

// ---------------------------------------------------------------------------
// `none` provider — explicit no-op
// ---------------------------------------------------------------------------

class NoneProvider implements CredentialProvider {
  readonly name = "none" as const;
  getTotp(_account: string): Promise<TotpResult> {
    return Promise.resolve({
      ok: false,
      provider: "none",
      error: "credentials provider is `none` — no vault backend is configured",
      hint: "set BROWX_CREDENTIALS_PROVIDER to one of: oathtool, 1password, bitwarden, lastpass",
    });
  }
  getCredential(_account: string): Promise<CredentialResult> {
    return Promise.resolve({
      ok: false,
      provider: "none",
      error: "credentials provider is `none` — no vault backend is configured",
      hint: "set BROWX_CREDENTIALS_PROVIDER to one of: oathtool, 1password, bitwarden, lastpass",
    });
  }
}

// ---------------------------------------------------------------------------
// `oathtool` provider — self-managed TOTP seeds
// ---------------------------------------------------------------------------

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
          'register the seed via BROWX_OATHTOOL_SEEDS="<account>=<BASE32SECRET>,…" or ' +
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
  getCredential(_account: string): Promise<CredentialResult> {
    return Promise.resolve({
      ok: false,
      provider: "oathtool",
      error: "oathtool is a TOTP-only backend; it does not store username/password",
      hint: "pair with another provider for credential lookup (1password, bitwarden, lastpass)",
    });
  }
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
        ok: false,
        provider: "1password",
        error: `1password CLI "${this.binary}" not found on PATH`,
        hint: "install the 1Password CLI from https://developer.1password.com/docs/cli/get-started/",
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        provider: "1password",
        error: `op item get --otp failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure you've run `op signin` and the item name is correct",
      };
    }
    const code = r.stdout.trim();
    if (!/^\d{6,8}$/.test(code)) {
      return {
        ok: false,
        provider: "1password",
        error: "1password returned unexpected output (not a 6-8 digit code)",
        hint: "verify the item has a one-time-password field configured",
      };
    }
    return { ok: true, code, provider: "1password" };
  }
  async getCredential(account: string): Promise<CredentialResult> {
    // `op item get <name> --fields label=username,label=password --format json`
    const r = await runArgv(
      [
        this.binary,
        "item",
        "get",
        account,
        "--fields",
        "label=username,label=password",
        "--format",
        "json",
      ],
      { timeoutMs: 5000 },
    );
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false,
        provider: "1password",
        error: `1password CLI "${this.binary}" not found on PATH`,
        hint: "install the 1Password CLI from https://developer.1password.com/docs/cli/get-started/",
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        provider: "1password",
        error: `op item get failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure you've run `op signin` and the item name is correct",
      };
    }
    const parsed = parseFieldsJson(r.stdout);
    if (!parsed.username || !parsed.password) {
      return {
        ok: false,
        provider: "1password",
        error: "1password item missing username or password field",
        hint: "verify the item has both a `username` and `password` field labelled accordingly",
      };
    }
    return {
      ok: true,
      provider: "1password",
      username: parsed.username,
      _password: parsed.password,
    } as ProviderCredentialInternal;
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
        ok: false,
        provider: "bitwarden",
        error: `bitwarden CLI "${this.binary}" not found on PATH`,
        hint: "install the Bitwarden CLI: https://bitwarden.com/help/cli/",
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        provider: "bitwarden",
        error: `bw get totp failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure $BW_SESSION is set (`bw unlock`) and the item exists",
      };
    }
    const code = r.stdout.trim();
    if (!/^\d{6,8}$/.test(code)) {
      return {
        ok: false,
        provider: "bitwarden",
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
        ok: false,
        provider: "bitwarden",
        error: `bitwarden CLI "${this.binary}" not found on PATH`,
        hint: "install the Bitwarden CLI: https://bitwarden.com/help/cli/",
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        provider: "bitwarden",
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
          ok: false,
          provider: "bitwarden",
          error: "bitwarden item missing username or password",
          hint: "verify the item has both fields populated",
        };
      }
      return {
        ok: true,
        provider: "bitwarden",
        username,
        _password: password,
      } as ProviderCredentialInternal;
    } catch (e) {
      return {
        ok: false,
        provider: "bitwarden",
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
        ok: false,
        provider: "lastpass",
        error: `lastpass CLI "${this.binary}" not found on PATH`,
        hint: "install lpass (macOS: `brew install lastpass-cli`)",
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        provider: "lastpass",
        error: `lpass show --field=otp failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure you've run `lpass login` and the item has an otp field",
      };
    }
    const code = r.stdout.trim();
    if (!/^\d{6,8}$/.test(code)) {
      return {
        ok: false,
        provider: "lastpass",
        error: "lastpass returned unexpected output (not a 6-8 digit code)",
        hint: "verify the item has a TOTP field configured",
      };
    }
    return { ok: true, code, provider: "lastpass" };
  }
  async getCredential(account: string): Promise<CredentialResult> {
    const r = await runArgv([this.binary, "show", "--username", "--password", account], {
      timeoutMs: 5000,
    });
    if (r.spawnError && /ENOENT/.test(r.spawnError)) {
      return {
        ok: false,
        provider: "lastpass",
        error: `lastpass CLI "${this.binary}" not found on PATH`,
        hint: "install lpass (macOS: `brew install lastpass-cli`)",
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        provider: "lastpass",
        error: `lpass show failed (exit ${r.code ?? "?"})`,
        hint: r.stderr.trim() || "ensure you've run `lpass login` and the item exists",
      };
    }
    // lpass emits the requested fields one per line in the order requested.
    const lines = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const [username, password] = lines;
    if (!username || !password) {
      return {
        ok: false,
        provider: "lastpass",
        error: "lastpass returned no username/password",
        hint: "verify the item has both fields populated",
      };
    }
    return {
      ok: true,
      provider: "lastpass",
      username,
      _password: password,
    } as ProviderCredentialInternal;
  }
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

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
export function resolveCredentialsProvider(env: NodeJS.ProcessEnv = process.env): {
  provider: CredentialProvider;
  config: CredentialsConfig;
} {
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
