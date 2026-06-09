import { describe, it, expect } from "vitest";
import {
  aliasFromAccount,
  applyCredentialToRegistry,
  makeFakeProvider,
  parseSeedsEnv,
  resolveCredentialsProvider,
  type ProviderCredentialInternal,
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
    // The W-V12 SecretRegistry contract: alias must match /^[A-Z][A-Z0-9_]*$/
    expect(/^[A-Z][A-Z0-9_]*$/.test(a)).toBe(true);
  });

  it("falls back to bare prefix on empty input", () => {
    expect(aliasFromAccount("")).toBe("PASSWORD");
    expect(aliasFromAccount("...")).toBe("PASSWORD");
  });

  it("respects a custom prefix", () => {
    expect(aliasFromAccount("acme", "TOKEN")).toBe("TOKEN_ACME");
  });

  it("always produces an alias that satisfies SecretRegistry's name regex", () => {
    const fixtures = ["acme", "Acme Corp", "1password-item", "x", "...", "foo@bar.com"];
    for (const f of fixtures) {
      const a = aliasFromAccount(f);
      expect(/^[A-Z][A-Z0-9_]*$/.test(a)).toBe(true);
    }
  });
});

describe("parseSeedsEnv", () => {
  it("parses comma-separated key=value pairs", () => {
    expect(parseSeedsEnv("acct1=ABC,acct2=DEF")).toEqual({ acct1: "ABC", acct2: "DEF" });
  });

  it("tolerates whitespace", () => {
    expect(parseSeedsEnv(" acct1 = ABC , acct2 = DEF ")).toEqual({ acct1: "ABC", acct2: "DEF" });
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

  it("normalises case on provider name", () => {
    const r = resolveCredentialsProvider({ BROWX_CREDENTIALS_PROVIDER: "1Password" });
    expect(r.config.provider).toBe("1password");
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

describe("applyCredentialToRegistry — W-V12 integration", () => {
  it("registers the password under an account-derived alias + returns aliasName, never the password", () => {
    const registry = new SecretRegistry();
    const provided: ProviderCredentialInternal = {
      ok: true,
      provider: "1password",
      username: "alice@example.com",
      _password: "hunter2!",
    };
    const result = applyCredentialToRegistry(provided, registry, "acme-corp");
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
    // dispatch (W-V12 fill/press substitution path).
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
    const result = applyCredentialToRegistry(provided, null, "acme");
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
    const result = applyCredentialToRegistry(refusal, registry, "acme");
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
    const result = applyCredentialToRegistry(provided, registry, "acme");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing username");
    expect(registry.size()).toBe(0);
  });
});

describe("makeFakeProvider", () => {
  it("provides a test seam for both endpoints", async () => {
    const fake = makeFakeProvider({
      getTotp: async (account) =>
        ({ ok: true, code: "123456", provider: "oathtool", _account: account }) as never,
      getCredential: async (account) =>
        ({
          ok: true,
          provider: "1password",
          username: `user_${account}`,
          _password: "pw",
        }) as ProviderCredentialInternal,
    });
    const t = await fake.getTotp("acme");
    expect(t.ok).toBe(true);
    expect(t.code).toBe("123456");
    const c = (await fake.getCredential("acme")) as ProviderCredentialInternal;
    expect(c.ok).toBe(true);
    expect(c.username).toBe("user_acme");
  });
});
