import { describe, it, expect } from "vitest";
import {
  accountError,
  aliasFromAccount,
  applyCredentialToRegistry,
  parseCredentialOrigins,
  parseSeedsEnv,
  resolveCredentialsProvider,
  type ProviderCredentialInternal,
  type RunResult,
} from "./credentials.js";
import { SecretRegistry } from "./secrets.js";

describe("aliasFromAccount", () => {
  it("uppercases + collapses non-identifier characters", () => {
    expect(aliasFromAccount("acme-corp")).toBe("PASSWORD_ACME_CORP");
    expect(aliasFromAccount("foo.bar baz")).toBe("PASSWORD_FOO_BAR_BAZ");
    expect(aliasFromAccount("a/b/c")).toBe("PASSWORD_A_B_C");
  });

  it("guarantees a leading letter when account starts with digit", () => {
    const a = aliasFromAccount("123abc");
    expect(a).toBe("PASSWORD_X_123ABC");
    // SecretRegistry contract: alias must match /^[A-Z][A-Z0-9_]*$/
    expect(/^[A-Z][A-Z0-9_]*$/.test(a)).toBe(true);
  });

  it("falls back to bare prefix on empty input", () => {
    expect(aliasFromAccount("")).toBe("PASSWORD");
    expect(aliasFromAccount("...")).toBe("PASSWORD");
  });
});

describe("parseSeedsEnv", () => {
  it("parses comma-separated key=value pairs", () => {
    expect(parseSeedsEnv("acct1=ABC,acct2=DEF")).toEqual({ acct1: "ABC", acct2: "DEF" });
  });

  it("returns {} on undefined / empty", () => {
    expect(parseSeedsEnv(undefined)).toEqual({});
    expect(parseSeedsEnv("")).toEqual({});
  });

  it("silently drops malformed entries", () => {
    expect(parseSeedsEnv("good=ok,bad,also=fine,=missingkey,missingvalue=")).toEqual({
      good: "ok",
      also: "fine",
    });
  });
});

describe("resolveCredentialsProvider", () => {
  it("defaults to oathtool when env is unset", () => {
    const r = resolveCredentialsProvider({});
    expect(r.config.provider).toBe("oathtool");
    expect(r.config.warnings).toEqual([]);
    expect(r.provider.name).toBe("oathtool");
  });

  it("honours an explicit provider", () => {
    for (const p of ["1password", "bitwarden", "lastpass", "none"] as const) {
      const r = resolveCredentialsProvider({ BROWX_CREDENTIALS_PROVIDER: p });
      expect(r.config.provider).toBe(p);
      expect(r.provider.name).toBe(p);
    }
  });

  it("warns + falls back to oathtool on unknown provider", () => {
    const r = resolveCredentialsProvider({ BROWX_CREDENTIALS_PROVIDER: "keychain" });
    expect(r.config.provider).toBe("oathtool");
    expect(r.config.warnings.length).toBe(1);
    expect(r.config.warnings[0]).toContain("unknown provider");
  });
});

describe("`none` provider", () => {
  it("refuses both calls with a clear hint", async () => {
    const { provider } = resolveCredentialsProvider({ BROWX_CREDENTIALS_PROVIDER: "none" });
    const t = await provider.getTotp("acme");
    expect(t.ok).toBe(false);
    expect(t.hint).toContain("BROWX_CREDENTIALS_PROVIDER");
    const c = await provider.getCredential("acme");
    expect(c.ok).toBe(false);
    expect(c.hint).toContain("BROWX_CREDENTIALS_PROVIDER");
  });
});

describe("oathtool provider — env config (no real binary spawn)", () => {
  it("returns a structured no-seed error when the account isn't registered", async () => {
    const { provider } = resolveCredentialsProvider({
      BROWX_CREDENTIALS_PROVIDER: "oathtool",
      BROWX_OATHTOOL_SEEDS: "other=ABCDEFGHIJKLMNOP",
    });
    const r = await provider.getTotp("acme");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no seed registered");
    expect(r.hint).toContain("BROWX_OATHTOOL_SEEDS");
  });

  it("reports a missing binary with an install hint (using a guaranteed-absent path)", async () => {
    const { provider } = resolveCredentialsProvider({
      BROWX_CREDENTIALS_PROVIDER: "oathtool",
      BROWX_OATHTOOL_BIN: "/definitely/not/a/real/path/oathtool-xyz",
      BROWX_OATHTOOL_SEEDS: "acme=ABCDEFGHIJKLMNOP",
    });
    const r = await provider.getTotp("acme");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found|failed/i);
    // Either install hint (ENOENT path) or generic failure — both are
    // valid structured-failure shapes; what matters is `ok:false` + a hint.
    expect(r.hint).toBeDefined();
  });

  it("returns a TOTP-not-supported message on getCredential", async () => {
    const { provider } = resolveCredentialsProvider({ BROWX_CREDENTIALS_PROVIDER: "oathtool" });
    const r = await provider.getCredential("acme");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("TOTP-only");
  });
});

describe("applyCredentialToRegistry — SecretRegistry integration", () => {
  it("registers the password under an account-derived alias + returns aliasName, never the password", () => {
    const registry = new SecretRegistry();
    const provided: ProviderCredentialInternal = {
      ok: true,
      provider: "1password",
      username: "alice@example.com",
      _password: "hunter2!",
    };
    const result = applyCredentialToRegistry(provided, registry, "acme-corp", [
      "https://app.example.com",
    ]);
    expect(result.ok).toBe(true);
    expect(result.username).toBe("alice@example.com");
    expect(result.aliasName).toBe("PASSWORD_ACME_CORP");
    // Password is NOT in the returned object
    expect(JSON.stringify(result)).not.toContain("hunter2");
    // Registry now masks the password value
    expect(registry.applyMaskInText("logged in with hunter2!")).toBe(
      "logged in with <PASSWORD_ACME_CORP>",
    );
    // And the registry can materialise the alias back to the real value at
    // dispatch (the fill/press substitution path used by SecretRegistry).
    const m = registry.materialize("<PASSWORD_ACME_CORP>", "https://app.example.com");
    expect(m.ok).toBe(true);
    expect(m.materialised).toBe(true);
    expect(m.value).toBe("hunter2!");
  });

  it("refuses when no registry is provided (secrets capability off)", () => {
    const provided: ProviderCredentialInternal = {
      ok: true,
      provider: "1password",
      username: "alice",
      _password: "hunter2",
    };
    const result = applyCredentialToRegistry(provided, null, "acme", ["https://app.example.com"]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("`secrets` capability is not enabled");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("surfaces a provider refusal verbatim without leaking _password", () => {
    const registry = new SecretRegistry();
    const refusal: ProviderCredentialInternal = {
      ok: false,
      provider: "bitwarden",
      error: "bw get item failed",
      hint: "ensure $BW_SESSION is set",
    };
    const result = applyCredentialToRegistry(refusal, registry, "acme", ["https://a.example"]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bw get item failed");
    expect("_password" in result).toBe(false);
  });

  it("flags an incomplete credential (missing username) without registering", () => {
    const registry = new SecretRegistry();
    const provided: ProviderCredentialInternal = {
      ok: true,
      provider: "1password",
      _password: "hunter2",
    };
    const result = applyCredentialToRegistry(provided, registry, "acme", ["https://a.example"]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing username");
    expect(registry.size()).toBe(0);
  });
});

describe("applyCredentialToRegistry — origin binding", () => {
  const provided: ProviderCredentialInternal = {
    ok: true,
    provider: "bitwarden",
    username: "alice",
    _password: "vault-pass-1",
  };

  it("binds the password to the origins it was fetched for", () => {
    const registry = new SecretRegistry();
    const result = applyCredentialToRegistry(provided, registry, "acme", [
      "https://app.example.com",
    ]);
    expect(result.ok).toBe(true);
    expect(result.origins).toEqual(["https://app.example.com"]);
    expect(registry.materialize("<PASSWORD_ACME>", "https://app.example.com/login").ok).toBe(true);
    for (const url of [
      "https://evil.test/?app.example.com",
      "https://app.example.com.evil.test/",
      "http://app.example.com/login",
    ]) {
      const m = registry.materialize("<PASSWORD_ACME>", url);
      expect(m.ok, url).toBe(false);
      expect(JSON.stringify(m), url).not.toContain("vault-pass-1");
    }
  });

  it("honours an operator list of several origins", () => {
    const registry = new SecretRegistry();
    const result = applyCredentialToRegistry(provided, registry, "acme", [
      "https://app.example.com",
      "sso.example.com",
    ]);
    expect(result.origins).toEqual(["https://app.example.com", "https://sso.example.com"]);
    expect(registry.materialize("<PASSWORD_ACME>", "https://sso.example.com/").ok).toBe(true);
  });

  it("refuses to register a password with no origin to bind it to", () => {
    const registry = new SecretRegistry();
    const result = applyCredentialToRegistry(provided, registry, "acme", []);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no origin/);
    expect(registry.size()).toBe(0);
    expect(JSON.stringify(result)).not.toContain("vault-pass-1");
  });
});

describe("parseCredentialOrigins", () => {
  it("parses per-account origin lists and drops an account whose entry does not parse", () => {
    const warnings: string[] = [];
    const out = parseCredentialOrigins(
      "acme=https://app.acme.test|https://sso.acme.test, other=other.test,bad=https://x.test/login",
      warnings,
    );
    expect(out).toEqual({
      acme: ["https://app.acme.test", "https://sso.acme.test"],
      other: ["other.test"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"bad"');
  });

  it("reaches the resolved config", () => {
    const r = resolveCredentialsProvider({ BROWX_CREDENTIAL_ORIGINS: "acme=https://a.test" });
    expect(r.config.origins).toEqual({ acme: ["https://a.test"] });
  });
});

describe("account allowlist", () => {
  it("accepts the names the vault CLIs use", () => {
    for (const a of [
      "acme",
      "acme-corp",
      "Acme Corp",
      "Shared/Acme",
      "alice@example.com",
      "user+tag@example.com",
      "github.com:alice",
      "3f2c9a1e-8b7d-4c6a-9e0f-1a2b3c4d5e6f",
      "a".repeat(128),
    ]) {
      expect(accountError(a), a).toBeNull();
    }
  });

  it("rejects a leading dash, other characters and over-long names", () => {
    for (const a of [
      "-o",
      "--session=x",
      " acme",
      "",
      "acme;rm",
      "acme\nnext",
      "acme$(id)",
      "a".repeat(129),
    ]) {
      expect(accountError(a), a).toMatch(/not a valid account name/);
    }
  });
});

describe("vault CLIs get `--` before the account", () => {
  function recordingRun(stdout: string) {
    const calls: string[][] = [];
    const run = (argv: readonly string[]): Promise<RunResult> => {
      calls.push([...argv]);
      return Promise.resolve({ ok: true, stdout, stderr: "", code: 0 });
    };
    return { calls, run };
  }

  it("1password", async () => {
    const { calls, run } = recordingRun("123456");
    const { provider } = resolveCredentialsProvider(
      { BROWX_CREDENTIALS_PROVIDER: "1password" },
      run,
    );
    await provider.getTotp("Acme Corp");
    await provider.getCredential("Acme Corp");
    expect(calls).toEqual([
      ["op", "item", "get", "--otp", "--", "Acme Corp"],
      [
        "op",
        "item",
        "get",
        "--fields",
        "label=username,label=password",
        "--format",
        "json",
        "--",
        "Acme Corp",
      ],
    ]);
  });

  it("bitwarden", async () => {
    const { calls, run } = recordingRun("123456");
    const { provider } = resolveCredentialsProvider(
      { BROWX_CREDENTIALS_PROVIDER: "bitwarden" },
      run,
    );
    await provider.getTotp("item-id-1");
    await provider.getCredential("item-id-1");
    expect(calls).toEqual([
      ["bw", "get", "totp", "--", "item-id-1"],
      ["bw", "get", "item", "--", "item-id-1"],
    ]);
  });

  it("lastpass", async () => {
    const { calls, run } = recordingRun("123456");
    const { provider } = resolveCredentialsProvider(
      { BROWX_CREDENTIALS_PROVIDER: "lastpass" },
      run,
    );
    await provider.getTotp("Shared/Acme");
    await provider.getCredential("Shared/Acme");
    expect(calls).toEqual([
      ["lpass", "show", "--field=otp", "--", "Shared/Acme"],
      ["lpass", "show", "--username", "--password", "--", "Shared/Acme"],
    ]);
  });

  it("puts `--` immediately before the account, last in argv", async () => {
    const { calls, run } = recordingRun("123456");
    for (const p of ["1password", "bitwarden", "lastpass"]) {
      const { provider } = resolveCredentialsProvider({ BROWX_CREDENTIALS_PROVIDER: p }, run);
      await provider.getTotp("acct");
      await provider.getCredential("acct");
    }
    for (const argv of calls) {
      expect(argv.at(-1)).toBe("acct");
      expect(argv.at(-2)).toBe("--");
    }
  });
});
